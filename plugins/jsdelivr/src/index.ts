import { Context, Assets, Schema, Logger, Time, sleep } from 'koishi'
import Git, { SimpleGit, SimpleGitOptions, ResetMode } from 'simple-git'
import { access, mkdir, rename, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import { File, Task, FileBase } from './file'
import { fromBuffer } from 'file-type'

declare module 'koishi' {
  interface Modules {
    jsdelivr: typeof import('.')
  }
}

export interface Branch {
  branch: number
  size: number
}

const PTC_BASE64 = 'base64://'

function toBranchName(id: number) {
  return id.toString(36).padStart(8)
}

export interface GitHubConfig {
  user: string
  repo: string
  token: string
}

export interface Config {
  git: Partial<SimpleGitOptions>
  github: GitHubConfig
  tempDir?: string
  flushInterval?: number
  maxBranchSize?: number
}

const githubSchema: Schema<GitHubConfig> = Schema.object({
  user: Schema.string().required(),
  repo: Schema.string().required(),
  token: Schema.string().required(),
})

export const schema: Schema<Config> = Schema.object({
  github: githubSchema,
  git: Schema.object({
    baseDir: Schema.string().required(),
  }, true),
  tempDir: Schema.string().default(resolve(__dirname, '../.temp')),
  flushInterval: Schema.number().default(Time.second * 3),
  maxBranchSize: Schema.number().default(50 * 1024 * 1024),
})

const logger = new Logger('jsdelivr')

export default class JsdelivrAssets implements Assets {
  types = ['image', 'audio', 'video', 'file'] as const
  git: SimpleGit
  taskQueue: Task[] = []
  taskMap = new Map<string, Task>()
  isActive = false

  constructor(private ctx: Context, public config: Config) {
    ctx.on('connect', async () => {
      await this.initRepo()
      this.isActive = true
      this.start()
    })

    ctx.on('disconnect', () => {
      this.isActive = false
    })
  }

  async start() {
    while (this.isActive) {
      try {
        await this.mainLoop()
      } catch (e) {
        logger.warn(`Loop failed: ${e.toString()}`)
      }
    }
  }

  private async initRepo() {
    const { git, github: { user, repo, token } } = this.config
    try {
      await access(join(git.baseDir, '.git'))
      this.git = Git(this.config.git)
    } catch (e) {
      logger.debug(`initializing repo at ${git.baseDir} ...`)
      await mkdir(git.baseDir, { recursive: true })
      this.git = Git(this.config.git)
      await this.git
        .init()
        .addRemote('origin', `https://${token}@github.com/${user}/${repo}.git`)
        .addConfig('core.autocrlf', 'false', false)
      await this.checkout(false, true)
      logger.debug('repository is initialized successfully')
    }
  }

  private async getBranch(forceNew?: boolean, offset = 1): Promise<Branch> {
    const [file] = await this.ctx.database.get('jsdelivr', {}, {
      // TODO support order
      // order: { id: 'desc' },
      fields: ['branch'],
      limit: 1,
    })
    if (!file) return { branch: offset, size: 0 }
    const { branch } = file
    if (forceNew) return { branch: branch + offset, size: 0 }
    const { size } = await this.ctx.database.aggregate('jsdelivr', {
      size: { $sum: 'size' },
    }, { branch: file.branch })
    if (size >= this.config.maxBranchSize) {
      logger.debug(`will switch to branch ${toBranchName(branch)}`)
      return { branch: branch + offset, size: 0 }
    } else {
      logger.debug(`will remain on branch ${toBranchName(branch)}`)
      return { branch, size }
    }
  }

  private async checkout(forceNew?: boolean, fetch?: boolean, offset = 1): Promise<Branch> {
    const res = await this.getBranch(forceNew, offset)
    const branchName = toBranchName(res.branch)
    if (!res.size) {
      logger.debug(`Checking out to a new branch ${branchName}`)
      await this.git.checkout(['--orphan', branchName])
      await this.git.raw(['rm', '-rf', '.'])
      logger.debug(`Checked out to a new branch ${branchName}`)
    } else {
      logger.debug(`Checking out existing branch ${branchName}`)
      if (fetch) {
        await this.git.fetch('origin', branchName)
      }
      await this.git.checkout(branchName, ['-f'])
      if (fetch) {
        await this.git.reset(ResetMode.HARD, [`origin/${branchName}`])
      }
      logger.debug(`Checked out existing branch ${branchName}`)
    }
    return res
  }

  private async createTask(file: FileBase) {
    return new Promise<string>((resolve, reject) => {
      let task = this.taskMap.get(file.hash)
      if (!task) {
        task = new Task(this, file)
        this.taskQueue.push(task)
        this.taskMap.set(file.hash, task)
      }
      task.resolvers.push(resolve)
      task.rejectors.push(reject)
    })
  }

  private getTasks(available: number) {
    const tasks: Task[] = []
    let size = 0
    while (this.taskQueue.length > 0) {
      const task = this.taskQueue[0]
      size += task.size
      if (size > available) break
      this.taskQueue.shift()
      tasks.push(task)
    }
    return tasks
  }

  private async mainLoop() {
    if (!this.taskQueue.length) {
      return sleep(this.config.flushInterval)
    }

    logger.debug(`Processing files.`)
    let branch = await this.checkout()
    let tasks = this.getTasks(this.config.maxBranchSize - branch.size)
    if (!tasks.length) {
      branch = await this.checkout(true)
      tasks = this.getTasks(this.config.maxBranchSize)
    }
    if (!tasks.length) return

    logger.debug(`Will process ${tasks.length} files.`)
    try {
      logger.debug(`Moving files.`)
      await Promise.all(tasks.map(async (task) => {
        task.branch = branch.branch
        await rename(task.tempPath, task.savePath)
      }))
      logger.debug(`Committing files.`)
      await this.git
        .add(tasks.map(task => task.filename))
        .commit('upload')
        .push('origin', toBranchName(branch.branch), ['-u', '-f'])
      logger.debug(`Saving file entries to database.`)
      await this.ctx.database.upsert('jsdelivr', tasks)
      logger.debug(`Finished processing files.`)
      for (const task of tasks) {
        task.resolve()
      }
    } catch (e) {
      logger.warn(`Errored processing files: ${e.toString()}`)
      await Promise.all(tasks.map(task => task.reject(e)))
    } finally {
      for (const file of tasks) {
        this.taskMap.delete(file.hash)
      }
    }
  }

  private async getAssetBuffer(url: string) {
    if (url.startsWith(PTC_BASE64)) {
      return Buffer.from(url.slice(PTC_BASE64.length), 'base64')
    }
    const data = await this.ctx.http.get.arraybuffer(url)
    return Buffer.from(data)
  }

  private async getFileName(buffer: Buffer) {
    const { ext } = await fromBuffer(buffer)
    return 'untitled.' + ext
  }

  toPublicUrl(file: File) {
    const { user, repo } = this.config.github
    return `https://cdn.jsdelivr.net/gh/${user}/${repo}@${file.branch}/${file.hash}-${file.name}`
  }

  async upload(url: string, name?: string) {
    const buffer = await this.getAssetBuffer(url)
    const hash = createHash('sha1').update(buffer).digest('hex')
    const [file] = await this.ctx.database.get('jsdelivr', { hash })
    if (file) return this.toPublicUrl(file)

    name ||= await this.getFileName(buffer)
    await writeFile(join(this.config.tempDir, hash), buffer)
    return this.createTask({ size: buffer.byteLength, hash, name })
  }

  async stats() {
    return this.ctx.database.aggregate('jsdelivr', {
      assetCount: { $count: 'id' },
      assetSize: { $sum: 'size' },
    })
  }
}

export const name = 'jsdelivr'

export function apply(ctx: Context, config: Config) {
  config = Schema.validate(config, schema)
  ctx.assets = new JsdelivrAssets(ctx, config)
}
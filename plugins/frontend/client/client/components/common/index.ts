import { App } from 'vue'
import Button from './button.vue'
import Choose from './choose.vue'
import Input from './input.vue'

export default function (app: App) {
  app.component('k-button', Button)
  app.component('k-choose', Choose)
  app.component('k-input', Input)
}
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { store } from './logic/store'
import { ledger } from './logic/ledger'
import './styles/global.css'

// 直接刷新子路由时也能恢复本地数据（HomeView 之外的页面依赖）
store.loadState()
ledger.load()

createApp(App).use(router).mount('#app')
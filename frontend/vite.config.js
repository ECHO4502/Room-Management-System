import { defineConfig } from 'vite'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from '@vant/auto-import-resolver'

// Vue 3 + Element Plus 房态管理前端
// 开发服务器：http://localhost:5173 ，/api 请求代理到后端 http://127.0.0.1:8000
export default defineConfig({
  plugins: [
    // Vant 4 按需引入（配合 unplugin-vue-components）
    Components({
      resolvers: [VantResolver()],
    }),
  ],
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      // 使用带模板编译器的构建版本，支持 app.js 中的 template 字符串
      vue: 'vue/dist/vue.esm-bundler.js',
    },
  },
})

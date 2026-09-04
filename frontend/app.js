/* 客房管理系统 - 房态管理前端
 * Vue 3 Composition API + Element Plus + Axios
 * 所有房间均为普通房间，下单时选择计费方式（全日租 full_day / 钟点房 hourly）。
 */
import { createApp, ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import axios from 'axios'
import './style.css'
// Vant 4 移动端组件（按需引入）
import {
  NavBar, Swipe, SwipeItem, Tag, Button, Popup, Field,
  CellGroup, Cell, RadioGroup, Radio, Stepper, Picker, Switch,
  showConfirmDialog, showToast,
} from 'vant'
import 'vant/es/nav-bar/style'
import 'vant/es/swipe/style'
import 'vant/es/swipe-item/style'
import 'vant/es/tag/style'
import 'vant/es/button/style'
import 'vant/es/popup/style'
import 'vant/es/field/style'
import 'vant/es/cell/style'
import 'vant/es/cell-group/style'
import 'vant/es/radio-group/style'
import 'vant/es/radio/style'
import 'vant/es/stepper/style'
import 'vant/es/picker/style'
import 'vant/es/switch/style'
import 'vant/es/dialog/style'
import 'vant/es/toast/style'

const api = axios.create({ baseURL: '/api', timeout: 15000 })
const isMobileView = () => window.innerWidth < 768
function notify(msg) {
  if (isMobileView()) showToast(msg)
  else ElMessage.success(msg)
}
function notifyError(msg) {
  if (isMobileView()) showToast({ message: msg, type: 'fail' })
  else ElMessage.error(msg)
}
api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const detail = err.response && err.response.data && err.response.data.detail
    const msg = typeof detail === 'string' ? detail : (err.message || '请求失败')
    notifyError(msg)
    return Promise.reject(err)
  }
)

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const DAY_COUNT = 31 // 今天 + 未来 30 天
const PHONE_RE = /^1\d{10}$/

const pad = (n) => String(n).padStart(2, '0')
const fmtMoney = (v) => '¥' + Number(v || 0).toFixed(2)
const fmtDate = (ts) => {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const fmtTime = (ts) => {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  return fmtDate(ts) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}
// 订单住退时间：钟点房显示具体时间（跨天自动进位到次日日期）；全日租/长租仅显示日期
const fmtStayTime = (o, which) => {
  const ts = which === 'start' ? o.start_timestamp : o.end_timestamp
  if (!o || !ts) return '-'
  if (o.order_type === 'hourly') {
    return fmtTime(ts)
  }
  return fmtDate(ts)
}
const fmtStayRange = (o) => {
  if (!o) return '-'
  if (o.order_type === 'hourly') {
    return fmtStayTime(o, 'start') + ' ~ ' + fmtStayTime(o, 'end')
  }
  return fmtDate(o.start_timestamp) + ' ~ ' + fmtDate(o.end_timestamp)
}
// 订单时长：钟点房显示小时数，日租/长租显示天数；退房后按实际时间差计算
const orderDurationLabel = (o) => {
  if (!o) return '-'
  if (o.order_type === 'hourly') {
    // 退房后按实际退房时间计算时长；未退房显示下单时长
    if (o.status === '已退房' && o.end_timestamp > o.start_timestamp) {
      const h = Math.round((o.end_timestamp - o.start_timestamp) / 3600 * 100) / 100
      return h + ' 小时'
    }
    return (Number(o.rent_hours) || 0) + ' 小时'
  }
  const s = Number(o.start_timestamp) || 0
  const e = Number(o.end_timestamp) || 0
  if (!s || !e || e <= s) return '-'
  return Math.max(1, Math.ceil((e - s) / 86400)) + ' 天'
}
const fmtHM = (ts) => {
  const d = new Date(ts * 1000)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}
const dayStart = (sec) => {
  const d = new Date(sec * 1000)
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}
const hmToSec = (s) => {
  const p = String(s || '').split(':').map(Number)
  return ((p[0] || 0) * 3600 + (p[1] || 0) * 60)
}
// 钟点房按日租原价计费：至少收一晚；订单时间每超过一个次日 12:00 即多收一晚
const hourlyNights = (startSec, endSec) => {
  let nights = 1
  let boundary = dayStart(startSec) + 36 * 3600
  while (endSec > boundary) { nights += 1; boundary += 86400 }
  return nights
}

const orderTypeLabel = (t) => ({ full_day: '全日租', hourly: '钟点房', long_term: '长租' }[t] || t)
const settleModeLabel = (m) => ({ once: '一次性先付', daily: '日结', ondeparture: '退房结算' }[m] || '一次性')
const displayName = (n) => (n || '').toString().trim() ? n.toString().trim() : '散客'
const orderStatusType = (s) => ({
  '已预订': 'warning',
  '已入住': 'primary',
  '已退房': 'success',
  '已取消': 'info',
}[s] || 'info')
// 渠道自定义颜色候选（至少 10 种，颜色直接用同色方格表示）
const CHANNEL_COLORS = [
  '#409EFF', '#67C23A', '#E6A23C', '#F56C6C', '#909399',
  '#FFB800', '#36CFC9', '#9254DE', '#FF6B81', '#00B8D9',
  '#7C4DFF', '#FF7043',
]

const App = {
  components: {
    VanNavBar: NavBar,
    VanSwipe: Swipe,
    VanSwipeItem: SwipeItem,
    VanTag: Tag,
    VanButton: Button,
    VanPopup: Popup,
    VanField: Field,
    VanCellGroup: CellGroup,
    VanCell: Cell,
    VanRadioGroup: RadioGroup,
    VanRadio: Radio,
    VanStepper: Stepper,
    VanPicker: Picker,
    VanSwitch: Switch,
  },
  setup() {
    const hotelName = ref('客房管理系统')
    const activeView = ref('status') // status | orders
    const statusTab = ref('grid') // grid | timeline
    const isMobile = ref(window.innerWidth < 768)
    const channels = ref([])
const authMode = ref('') // '' | 'login' | 'setup'
const authForm = reactive({ username: '', password: '', confirm: '' })
const authError = ref('')
const localAccess = ref(true)
const authSaving = ref(false)


    function sourceColor(src) {
      if (!src) return '#909399'
      const c = channels.value.find((x) => x.name === src)
      return c ? c.color : '#909399'
    }
    const sourceOptions = computed(() => channels.value.map((c) => c.name))

    function handleResize() {
      isMobile.value = window.innerWidth < 768
    }
    window.addEventListener('resize', handleResize)
    onBeforeUnmount(() => window.removeEventListener('resize', handleResize))

    // ---------- 移动端 ----------
    function dayObj(ts) {
      const d = new Date(ts * 1000)
      return {
        ts,
        date: fmtDate(ts),
        monthDay: (d.getMonth() + 1) + '/' + d.getDate(),
        week: '周' + WEEKDAYS[d.getDay()],
        isToday: fmtDate(ts) === fmtDate(Date.now() / 1000),
      }
    }
    const mobileDay = ref(dayObj(dayStart(Date.now() / 1000)))
    const mobileStatDateLabel = computed(() =>
      mobileDay.value.isToday ? '今日' : fmtDate(mobileDay.value.ts))

    watch(mobileDay, (d) => {
      loadStats(d.ts)
    })

    function mobileSegments(room) {
      return (segmentsMap.value[room.id] && segmentsMap.value[room.id][mobileDay.value.date]) || []
    }
    function activeMobileSegs(room) {
      return mobileSegments(room).filter((s) => s.status !== '已退房')
    }
    function mobileSegLabel(seg) {
      const endLabel = seg.end >= mobileDay.value.ts + 86400 ? '24:00' : fmtHM(seg.end)
      const type = seg.order_type === 'full_day' ? '全日' : seg.order_type === 'long_term' ? '长租' : '钟点'
      const statusTag = { '已退房': '已退房·', '已入住': '已入住·', '已预订': '已预订·' }[seg.status] || ''
      // 退房日并入前一天，不单独标记收款
      const payMark = seg.settle_mode === 'daily' && !seg.is_checkout_day
        ? (seg.paid ? '·已收' : '·未收') : ''
      const timePart = seg.order_type === 'hourly'
        ? fmtHM(seg.start)
        : fmtHM(seg.start) + '-' + endLabel
      return statusTag + timePart + ' ' + type + '·'
        + displayName(seg.guest_name) + ' ¥' + seg.total_price + payMark
    }
    function openMobileOrder(room) {
      openCreateOrder(room, mobileDay.value)
    }
    function openMobileDetail(room) {
      openDetail(room, mobileDay.value)
    }
    function dateStrOf(ms) {
      return ms ? fmtDate(Math.floor(Number(ms) / 1000)) : ''
    }
    function datetimeStrOf(ms) {
      const d = new Date(Number(ms) || 0)
      if (!d.getTime()) return ''
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    function parseLocalDate(str) {
      if (!str) return 0
      const p = str.split('-').map(Number)
      return new Date(p[0], p[1] - 1, p[2]).getTime()
    }
    function parseLocalDateTime(str) {
      if (!str) return 0
      const parts = str.split('T')
      const dp = parts[0].split('-').map(Number)
      const tp = parts[1].split(':').map(Number)
      return new Date(dp[0], dp[1] - 1, dp[2], tp[0], tp[1]).getTime()
    }
    const roomPickerShow = ref(false)
    const guestSourcePicker = ref(false)
    const guestSourceColumns = computed(() =>
      sourceOptions.value.map((s) => ({ text: s, value: s })))
    const roomPickerColumns = computed(() =>
      availableRooms.value.map((r) => ({
        text: r.room_number + ' ' + r.room_category,
        value: r.id,
      })))
    function onRoomPickConfirm({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length) {
        orderDialog.form.room_id = selectedOptions[0].value
      }
      roomPickerShow.value = false
    }

    function onGuestSourcePick({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length) {
        orderDialog.form.guest_source = selectedOptions[0].value
      }
      guestSourcePicker.value = false
      syncSettleByChannel()
    }

    async function askConfirm(opts) {
      if (isMobile.value) {
        try {
          await showConfirmDialog({
            title: opts.title,
            message: opts.message,
            confirmButtonText: opts.confirmText || '确认',
            cancelButtonText: '取消',
          })
        } catch (e) { return false }
        return true
      }
      try {
        await ElMessageBox.confirm(opts.message, opts.title, {
          type: 'warning',
          confirmButtonText: opts.confirmText || '确认',
          cancelButtonText: '取消',
        })
      } catch (e) { return false }
      return true
    }

    // ---------- 房态总览 ----------
    const stats = reactive({ expected_arrivals: 0, expected_checkouts: 0, today_revenue: 0, today_repay: 0, pending_repay: 0, total_sales: 0 })
    const rooms = ref([])
    const statusMap = ref({}) // roomId -> { 'YYYY-MM-DD': 状态 }
    const segmentsMap = ref({}) // roomId -> { 'YYYY-MM-DD': [segments] }
    // 默认网格从“前一天”开始展示
    const rangeStart = ref(dayStart(Date.now() / 1000) - 3 * 86400)
    const loading = ref(false)
    // ---------- 门店 ----------
    const stores = ref([])
    const currentStoreId = ref(null)
    const storeDialog = reactive({ visible: false, saving: false, name: '' })
    // 订单/房间页面独立的门店筛选：默认跟随当前门店，可切换全部或其他门店
    const orderStoreFilter = ref('all')
    const roomStoreFilter = ref(null)

    watch(currentStoreId, (v) => {
      if (v) {
        orderStoreFilter.value = v
        roomStoreFilter.value = v
      }
    })

    async function loadStores() {
      stores.value = await api.get('/stores')
      if (!stores.value.length) return
      const cur = currentStoreId.value
      if (!cur || !stores.value.some((s) => s.id === cur)) {
        currentStoreId.value = stores.value[0].id
      }
    }

    function switchStore(id) {
      if (id === currentStoreId.value) return
      currentStoreId.value = id
      loadAll()
      if (activeView.value === 'orders') loadOrders()
      else if (activeView.value === 'rooms') loadRoomList()
    }

    function openAddStore() {
      storeDialog.name = ''
      storeDialog.visible = true
    }

    async function saveStore() {
      if (!storeDialog.name.trim()) { ElMessage.warning('请输入门店名称'); return }
      storeDialog.saving = true
      try {
        const created = await api.post('/stores', { name: storeDialog.name.trim() })
        notify('门店已新增：' + created.name)
        storeDialog.visible = false
        await loadStores()
        currentStoreId.value = created.id
        await loadAll()
      } catch (e) { /* 拦截器已提示 */ } finally {
        storeDialog.saving = false
      }
    }

    async function removeStore(s) {
      if (!(await askConfirm({
        title: '删除门店',
        message: '确定删除门店「' + s.name + '」吗？（该门店下需没有房间）',
        confirmText: '删除',
      }))) return
      try {
        await api.delete('/stores/' + s.id, { params: { confirm: true } })
        notify('门店已删除')
        await loadStores()
        await loadAll()
      } catch (e) { /* 拦截器已提示 */ }
    }

    // ---------- 时间轴（24 小时：00:00-24:00，支持前一天/后一天切换） ----------
    const timelineOrders = ref([])
    const timelineLoading = ref(false)
    const tlTicks = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]

    const selectedDate = ref(dayStart(Date.now() / 1000))
    const tlToday = computed(() => selectedDate.value)
    const tlPct = (sec) => ((sec / 86400) * 100).toFixed(3) + '%'

    function timelineSegments(roomId) {
      const t0 = selectedDate.value
      const t1 = t0 + 86400
      const out = []
      for (const o of timelineOrders.value) {
        if (o.room_id !== roomId) continue
        let start
        let e
        if (o.order_type === 'full_day') {
          // 全日租实际占用：入住日 14:00 → 退房日 12:00（跨日时切换日期占用位置随之变化）
          const d0 = dayStart(o.start_timestamp)
          const d1 = dayStart(o.end_timestamp)
          start = d0 + 14 * 3600
          e = d1 + 12 * 3600
          // 同日结束的退化订单：按原始时间范围显示
          if (e <= start) {
            start = o.start_timestamp
            e = o.end_timestamp
          }
        } else {
          start = o.start_timestamp
          e = o.end_timestamp
        }
        start = Math.max(start, t0)
        e = Math.min(e, t1)
        if (e <= start) continue
        out.push({ order: o, start, end: e })
      }
      out.sort((a, b) => a.start - b.start)
      return out
    }

    async function loadTimeline() {
      const t = selectedDate.value
      timelineLoading.value = true
      try {
        const list = await api.get('/orders', {
          params: { date_from: t, date_to: t + 86400, store_id: currentStoreId.value },
        })
        // 已退房订单也显示（灰色），仅排除已取消
        timelineOrders.value = list.filter((o) => o.status !== '已取消')
      } finally {
        timelineLoading.value = false
      }
    }

    function timelineShift(days) {
      selectedDate.value = dayStart(selectedDate.value + days * 86400)
      loadTimeline()
      loadStats()
    }

    function onDayHeadClick(d) {
      selectedDate.value = d.ts
      if (statusTab.value === 'timeline') loadTimeline()
      loadStats()
    }

    // 进入时间轴时加载数据
    watch(statusTab, (v) => {
      if (v === 'timeline') {
        loadTimeline()
      }
    })

    const days = computed(() => {
      const list = []
      for (let i = 0; i < DAY_COUNT; i++) {
        const ts = rangeStart.value + i * 86400
        const d = new Date(ts * 1000)
        list.push({
          ts,
          date: fmtDate(ts),
          monthDay: (d.getMonth() + 1) + '/' + d.getDate(),
          week: '周' + WEEKDAYS[d.getDay()],
          isToday: fmtDate(ts) === fmtDate(Date.now() / 1000),
        })
      }
      return list
    })
    const rangeEnd = computed(() => rangeStart.value + (DAY_COUNT - 1) * 86400)
    const gridStyle = computed(() => ({
      gridTemplateColumns: '170px repeat(' + DAY_COUNT + ', 120px)',
    }))

    // 手机端日期滑动：今天前后各 30 天（可回看之前日期）
    const mobileDays = computed(() => {
      const base = dayStart(Date.now() / 1000) - 30 * 86400
      const list = []
      for (let i = 0; i < 61; i++) list.push(dayObj(base + i * 86400))
      return list
    })

    function cellSegs(room, day) {
      const rid = room && room.id
      return (segmentsMap.value[rid] && segmentsMap.value[rid][day.date]) || []
    }
    function activeSegs(room, day) {
      return cellSegs(room, day).filter((s) => s.status !== '已退房')
    }
    function cellClass(room, day) {
      if (room.status === '维修') return 'st-maintenance'
      return activeSegs(room, day).length ? 'st-partial' : 'st-free'
    }
    function tRange(start, end, dayTs) {
      const hm = (ts) => {
        const d = new Date(ts * 1000)
        return pad(d.getHours()) + ':' + pad(d.getMinutes())
      }
      // 结束时间按实际时刻显示；占用到当日 24:00 时显示 24:00
      const eLabel = end >= dayTs + 86400 ? '24:00' : hm(end)
      return hm(start) + '-' + eLabel
    }
    function stripLeft(seg, day) {
      return ((seg.start - day.ts) / 86400 * 100).toFixed(2) + '%'
    }
    function stripWidth(seg, day) {
      return ((seg.end - seg.start) / 86400 * 100).toFixed(2) + '%'
    }
    function segBlockLabel(seg, day) {
      const name = displayName(seg.guest_name)
      const price = '¥' + seg.total_price
      const statusText = { '已入住': '已入住', '已退房': '已退房', '已预订': '已预订' }[seg.status] || ''
      const statusPrefix = statusText ? '[' + statusText + '] ' : ''
      if (seg.order_type === 'hourly') {
        return statusPrefix + fmtHM(seg.start) + ' ' + name + ' ' + price
      }
      const prefix = seg.order_type === 'long_term' ? '长·' : '全·'
      return statusPrefix + prefix + name + ' ' + price
    }
    // 跨天同一订单：合并为一条连续色块，在首日格子渲染并溢出到后续格子
    const spanMap = computed(() => {
      const result = {}
      const firstDay = {}
      const fullRange = {}
      for (let di = 0; di < days.value.length; di++) {
        const d = days.value[di]
        for (const room of rooms.value) {
          const segs = (segmentsMap.value[room.id] && segmentsMap.value[room.id][d.date]) || []
          for (const s of segs) {
            if (!(s.order_id in firstDay)) firstDay[s.order_id] = di
            const r = fullRange[s.order_id] || { start: s.start, end: s.end, seg: s }
            r.start = Math.min(r.start, s.start)
            r.end = Math.max(r.end, s.end)
            fullRange[s.order_id] = r
          }
        }
      }
      for (const room of rooms.value) {
        const sm = segmentsMap.value[room.id] || {}
        const perRoom = {}
        for (let di = 0; di < days.value.length; di++) {
          const d = days.value[di]
          const segs = sm[d.date] || []
          const renders = []
          for (const s of segs) {
            if (s.settle_mode === 'daily' && firstDay[s.order_id] === di) {
              // 日结订单合并为一长条，内部按“过夜”划分已收/未收盒子：
              // 每个盒子 = 当晚 12:00 → 次日 12:00（首晚自入住时间起），
              // 退房日区域并入最后一晚，不单独计费。
              const fr = fullRange[s.order_id]
              const nightDays = []
              for (let k = 0; k < days.value.length; k++) {
                const dd = days.value[k]
                const dseg = (sm[dd.date] || []).find((x) => x.order_id === s.order_id)
                if (!dseg || dseg.is_checkout_day) continue
                nightDays.push({ ts: dd.ts, paid: dseg.paid })
              }
              const dayCells = []
              const spanLen = Math.max(1, fr.end - fr.start)
              for (let i = 0; i < nightDays.length; i++) {
                const nd = nightDays[i]
                const isLast = i === nightDays.length - 1
                const start = i === 0 ? fr.start : nd.ts + 12 * 3600
                const end = isLast ? fr.end : nd.ts + 36 * 3600
                if (end <= start) continue
                dayCells.push({
                  left: (start - fr.start) / spanLen * 100,
                  width: (end - start) / spanLen * 100,
                  paid: nd.paid,
                  ts: nd.ts,
                  isCheckoutDay: false,
                })
              }
              renders.push({
                seg: fr.seg,
                left: (fr.start - d.ts) / 86400 * 100,
                width: (fr.end - fr.start) / 86400 * 100,
                dayCells,
              })
            } else if (firstDay[s.order_id] === di) {
              const fr = fullRange[s.order_id]
              renders.push({
                seg: fr.seg,
                left: (fr.start - d.ts) / 86400 * 100,
                width: (fr.end - fr.start) / 86400 * 100,
              })
            }
          }
          if (renders.length) perRoom[d.date] = renders
        }
        result[room.id] = perRoom
      }
      return result
    })
    function renderSegs(room, day) {
      const m = spanMap.value[room.id]
      return (m && m[day.date]) || []
    }
    function spanStyle(r) {
      const bg = r.seg.status === '已退房' ? '#C0C4CC' : sourceColor(r.seg.guest_source)
      return {
        left: r.left.toFixed(3) + '%',
        width: r.width.toFixed(3) + '%',
        background: bg,
        borderRadius: '3px',
      }
    }
    function stripClass(seg) {
      return {
        'is-checkedout': seg.status === '已退房',
        'is-auto': seg.auto === 1 || seg.auto === true,
        'is-checkedin': seg.status === '已入住',
      }
    }
    function segTooltip(seg) {
      const pay = seg.settle_mode === 'daily' ? '｜日结' : ''
      const timeLabel = (seg.order_type === 'full_day' || seg.order_type === 'long_term')
        ? fmtDate(seg.start)
        : fmtHM(seg.start)
      return timeLabel + ' ｜ ' + displayName(seg.guest_name)
        + ' ｜ ' + (seg.guest_source || '-')
        + ' ｜ ' + orderTypeLabel(seg.order_type)
        + ' ｜ ' + seg.status
        + ' ｜ ¥' + seg.total_price + pay
    }
    function pickFreeStart(segs, dayTs) {
      // 在部分占用的一天里，找第一个 ≥2 小时的空闲时段作为默认下单时间
      const dayEnd = dayTs + 86400
      const sorted = [...segs].sort((a, b) => a.start - b.start)
      const now = Date.now() / 1000
      let cursor = dayTs
      const candidates = []
      for (const s of sorted) {
        if (s.start - cursor >= 7200) candidates.push(cursor)
        cursor = Math.max(cursor, s.end)
      }
      if (dayEnd - cursor >= 7200) candidates.push(cursor)
      if (!candidates.length) return null
      let start = candidates[0]
      if (dayTs === dayStart(now)) start = Math.max(start, now + 1800)
      return start + 3600 <= dayEnd ? start : null
    }

    async function loadStats(ts) {
      const t = ts || selectedDate.value
      Object.assign(stats, await api.get('/statistics/today', { params: { date_ts: t } }))
    }
    const statDateLabel = computed(() => {
      const today = dayStart(Date.now() / 1000)
      return selectedDate.value === today ? '今日' : fmtDate(selectedDate.value)
    })
    async function loadRooms() {
      rooms.value = await api.get('/rooms', { params: { store_id: currentStoreId.value } })
    }
    async function loadSettings() {
      try {
        const list = await api.get('/settings')
        const item = list.find((x) => x.key === 'hotel_name')
        if (item && item.value) hotelName.value = item.value
      } catch (e) { /* 设置读取失败不阻塞页面 */ }
    }
    async function loadChannels() {
      try {
        channels.value = await api.get('/channels')
      } catch (e) {
        channels.value = []
      }
    }
    async function loadStatus() {
      const now = dayStart(Date.now() / 1000)
      // 手机端需要可回看之前日期：一次性加载前后 30 天
      const start = isMobile.value ? now - 30 * 86400 : rangeStart.value
      const end = isMobile.value ? now + 30 * 86400 : rangeEnd.value
      const data = await api.get('/room-status', {
        params: {
          start_date: start,
          end_date: end,
          store_id: currentStoreId.value,
        },
      })
      const smap = {}
      const gmap = {}
      data.rooms.forEach((r) => {
        smap[r.room_id] = r.statuses
        gmap[r.room_id] = r.segments
      })
      statusMap.value = smap
      segmentsMap.value = gmap
    }
    async function loadAll() {
      loading.value = true
      try {
        await loadStores()
        await Promise.all([
          loadStats(), loadRooms(), loadStatus(), loadSettings(), loadChannels(),
          loadTimeline(), loadDbInfo(), loadAlerts(),
        ])
      } finally {
        loading.value = false
      }
    }

    function shift(delta) {
      rangeStart.value = dayStart(rangeStart.value + delta * 86400)
      loadStatus()
    }
    function goToday() {
      rangeStart.value = dayStart(Date.now() / 1000) - 3 * 86400
      selectedDate.value = dayStart(Date.now() / 1000)
      loadStatus()
      loadTimeline()
      loadStats()
    }
    const quickDate = ref(null)
    function onQuickDate(v) {
      if (!v) return
      const t = dayStart(Number(v) / 1000)
      rangeStart.value = t - 3 * 86400
      selectedDate.value = t
      quickDate.value = null
      loadStatus()
      loadTimeline()
      loadStats()
    }

    // ---------- 订单列表 ----------
    const orderList = ref([])
    const orderListLoading = ref(false)
    const orderFilters = reactive({
      gran: 'all',
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
      day: Date.now(),
      range: null,
      room_number: '', keyword: '', order_type: 'all', source: 'all',
    })

    function orderRange() {
      const f = orderFilters
      if (f.gran === 'all') {
        if (f.range && f.range.length === 2) {
          return [Math.floor(Number(f.range[0]) / 1000), Math.floor(Number(f.range[1]) / 1000)]
        }
        return null
      }
      const y0 = (y) => Math.floor(new Date(y, 0, 1).getTime() / 1000)
      if (f.gran === 'year') return [y0(Number(f.year)), y0(Number(f.year) + 1)]
      if (f.gran === 'month') {
        return [
          Math.floor(new Date(Number(f.year), Number(f.month) - 1, 1).getTime() / 1000),
          Math.floor(new Date(Number(f.year), Number(f.month), 1).getTime() / 1000),
        ]
      }
      if (f.gran === 'day') {
        const sec = dayStart(Math.floor((Number(f.day) || Date.now()) / 1000))
        return [sec, sec + 86400]
      }
      if (f.range && f.range.length === 2) {
        return [Math.floor(Number(f.range[0]) / 1000), Math.floor(Number(f.range[1]) / 1000)]
      }
      return null
    }

    // ---------- 系统设置 ----------
    const dbInfo = reactive({ version: '-', rooms: 0, orders: 0, db_path: '', backups_dir: '' })
    const backingUp = ref(false)
    const qrSrc = ref('')

    async function loadQrCode() {
      try {
        const res = await axios.get('/api/qrcode', { responseType: 'blob' })
        if (qrSrc.value) URL.revokeObjectURL(qrSrc.value)
        qrSrc.value = URL.createObjectURL(res.data)
      } catch (e) { /* 二维码加载失败不阻塞页面 */ }
    }

    async function loadDbInfo() {
      Object.assign(dbInfo, await api.get('/db-info'))
      loadQrCode()
    }

    async function downloadBackup() {
      backingUp.value = true
      try {
        await api.post('/backup/manual', null, { params: { reason: '一键备份' } })
        notify('备份已保存到 data/backups')
        await loadBackups()
      } catch (e) { /* 拦截器已提示 */ } finally {
        backingUp.value = false
      }
    }

    // ---------- 房间管理 ----------
    const roomList = ref([])
    const roomListLoading = ref(false)
    const roomFilters = reactive({ status: '', active: '', keyword: '' })
    const roomTemplates = ref([])
    const roomCategories = ref([])
    const templatePicker = ref(false)
    const templateManagerDialog = reactive({ visible: false })
    const selectedTemplateId = ref(null)
    const roomBatchDialog = reactive({ visible: false, saving: false, floor_start: 1, floor_end: 1, rooms_per_floor: 3 })
    const roomBatchEditDialog = reactive({
      visible: false, saving: false, store_id: null, room_category: '', floor: null,
      set_base_price: null, delta_base_price: 0, set_hourly_price: null, delta_hourly_price: 0,
    })
    const batchStorePicker = ref(false)
    const batchCategoryPicker = ref(false)
    const autoSettings = reactive({ checkin: false, checkout: false, extend: false })
    const autoMaster = ref(false)
    const automationLogs = ref([])
    const autoLogDialog = reactive({ visible: false })
    const alertOpen = ref(false)
    const backupDialog = reactive({ visible: false })
    const backupList = ref([])
    const autoActionPicker = ref(false)
    const roomDialog = reactive({
      visible: false, isEdit: false, id: null, saving: false,
      form: {
        room_number: '', room_name: '', room_category: '标准间',
        base_price: 100, hourly_price: 0, status: '空闲', is_active: 1, remark: '',
      },
    })
    const roomCategoryPicker = ref(false)
    const roomStatusPicker = ref(false)
    const storePicker = ref(false)
    const roomCategoryColumns = computed(() =>
      roomCategories.value.map((c) => ({ text: c.name, value: c.name })))
    const templateColumns = computed(() => [
      { text: '不套用模板', value: null },
      ...roomTemplates.value.map((t) => ({ text: t.name + '（' + t.room_category + ' ¥' + t.base_price + '）', value: t.id })),
    ])
    const roomStatusColumns = computed(() =>
      ['空闲', '维修'].map((s) => ({ text: s, value: s })))
    const storeColumns = computed(() => stores.value.map((s) => ({ text: s.name, value: s.id })))

    async function loadRoomList() {
      roomListLoading.value = true
      loadRoomCategories()
      loadRoomTemplates()
      try {
        roomList.value = await api.get('/rooms', {
          params: {
            status: roomFilters.status === '需打扫' ? undefined : (roomFilters.status || undefined),
            need_clean: roomFilters.status === '需打扫' ? 1 : undefined,
            active: roomFilters.active === '' ? undefined : Number(roomFilters.active),
            include_inactive: roomFilters.active === '' ? true : undefined,
            keyword: roomFilters.keyword || undefined,
            store_id: roomStoreFilter.value || undefined,
          },
        })
      } finally {
        roomListLoading.value = false
      }
    }

    function openCreateRoom() {
      roomDialog.isEdit = false
      roomDialog.id = null
      roomDialog.form = {
        room_number: '', room_name: '', room_category: '标准间',
        base_price: 100, hourly_price: 0, status: '空闲', is_active: 1,
        store_id: currentStoreId.value,
      }
      loadRoomTemplates()
      roomDialog.visible = true
    }

    function openEditRoom(row) {
      roomDialog.isEdit = true
      roomDialog.id = row.id
      roomDialog.origStatus = row.status
      roomDialog.origActiveOrders = row.active_orders || 0
      roomDialog.form = {
        room_number: row.room_number,
        room_name: row.room_name,
        room_category: row.room_category,
        base_price: row.base_price,
        hourly_price: row.hourly_price || 0,
        remark: row.remark || '',
        status: row.status,
        is_active: row.is_active,
        store_id: row.store_id,
      }
      loadRoomTemplates()
      roomDialog.visible = true
    }

    function onRoomCategoryPick({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length) {
        roomDialog.form.room_category = selectedOptions[0].value
      }
      roomCategoryPicker.value = false
    }

    function onRoomStatusPick({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length) {
        roomDialog.form.status = selectedOptions[0].value
      }
      roomStatusPicker.value = false
    }

    function onStorePick({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length) {
        roomDialog.form.store_id = selectedOptions[0].value
      }
      storePicker.value = false
    }

    function storeName(id) {
      const s = stores.value.find((x) => x.id === id)
      return s ? s.name : ''
    }

    function roomStatusMeta(room) {
      if (!room.is_active) return { text: '已停用', cls: 'st-off' }
      const map = {
        '空闲': ['空闲', 'st-free'],
        '维修': ['维修', 'st-repair'],
        '已入住': ['已入住', 'st-in'],
        '已预订': ['已预订', 'st-booked'],
      }
      const m = map[room.status] || ['空闲', 'st-free']
      return { text: m[0], cls: m[1] }
    }

    // ---------- 房间模板 / 自定义房型 / 批量操作 ----------
    async function loadRoomTemplates() {
      try { roomTemplates.value = await api.get('/room-templates') } catch (e) { roomTemplates.value = [] }
    }
    async function loadRoomCategories() {
      try { roomCategories.value = await api.get('/room-categories') } catch (e) { roomCategories.value = [] }
    }
    function onTemplatePick({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length) applyRoomTemplateById(selectedOptions[0].value)
      templatePicker.value = false
    }
    function applyRoomTemplateById(id) {
      const t = roomTemplates.value.find((x) => x.id === id)
      if (!t) {
        selectedTemplateId.value = null
        return
      }
      roomDialog.form.room_category = t.room_category
      roomDialog.form.base_price = t.base_price
      roomDialog.form.hourly_price = t.hourly_price
      selectedTemplateId.value = id
      notify('已套用模板：' + t.name)
    }
    async function deleteRoomTemplate(tpl) {
      if (!(await askConfirm({
        title: '删除模板',
        message: '确定删除模板「' + tpl.name + '」吗？',
        confirmText: '删除',
      }))) return
      try {
        await api.delete('/room-templates/' + tpl.id, { params: { confirm: true } })
        notify('模板已删除')
        if (selectedTemplateId.value === tpl.id) selectedTemplateId.value = null
        await loadRoomTemplates()
      } catch (e) { /* 拦截器已提示 */ }
    }
    function cancelRoomTemplate() {
      selectedTemplateId.value = null
    }
    async function openSaveTemplate() {
      try {
        const { value } = await ElMessageBox.prompt('请输入模板名称', '保存为房间模板', {
          confirmButtonText: '保存',
          cancelButtonText: '取消',
          inputPattern: /\S+/,
          inputErrorMessage: '模板名称不能为空',
        })
        await api.post('/room-templates', {
          name: String(value).trim(),
          room_category: roomDialog.form.room_category,
          base_price: Number(roomDialog.form.base_price) || 0,
          hourly_price: Math.min(Number(roomDialog.form.hourly_price) || 0, Number(roomDialog.form.base_price) || 0),
        })
        notify('模板已保存')
        await loadRoomTemplates()
      } catch (e) { /* 用户取消或拦截器提示 */ }
    }
    function openRoomBatch() {
      roomBatchDialog.visible = true
    }
    async function batchCreateRooms() {
      const f = roomBatchDialog
      const fs = Number(f.floor_start)
      const fe = Number(f.floor_end)
      const rpf = Number(f.rooms_per_floor)
      if (!(fs >= 1) || !(fe >= fs) || !(rpf >= 1)) {
        ElMessage.warning('请填写正确的楼层起止与每层房间数')
        return
      }
      roomBatchDialog.saving = true
      try {
        const res = await api.post('/rooms/batch', {
          store_id: roomDialog.form.store_id || currentStoreId.value,
          room_category: roomDialog.form.room_category,
          base_price: Number(roomDialog.form.base_price) || 0,
          hourly_price: Math.min(Number(roomDialog.form.hourly_price) || 0, Number(roomDialog.form.base_price) || 0),
          floor_start: fs,
          floor_end: fe,
          rooms_per_floor: rpf,
        })
        notify('已新建 ' + res.created.length + ' 间' + (res.skipped.length ? '，跳过已存在 ' + res.skipped.length + ' 间' : ''))
        roomBatchDialog.visible = false
        roomDialog.visible = false
        await Promise.all([loadRoomList(), loadAll()])
      } catch (e) { /* 拦截器已提示 */ } finally {
        roomBatchDialog.saving = false
      }
    }
    function openBatchEdit() {
      roomBatchEditDialog.visible = true
    }
    function onBatchStorePick({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length) roomBatchEditDialog.store_id = selectedOptions[0].value
      batchStorePicker.value = false
    }
    function onBatchCategoryPick({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length) roomBatchEditDialog.room_category = selectedOptions[0].value
      batchCategoryPicker.value = false
    }
    async function saveBatchEdit() {
      const f = roomBatchEditDialog
      // 手机端数字输入为字符串，统一转数值后再校验/提交，避免 422
      const toNum = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
      const setBase = toNum(f.set_base_price)
      const setHourly = toNum(f.set_hourly_price)
      const deltaBase = Number(f.delta_base_price) || 0
      const deltaHourly = Number(f.delta_hourly_price) || 0
      const floorVal = toNum(f.floor)
      if (setBase == null && deltaBase === 0 && setHourly == null && deltaHourly === 0) {
        ElMessage.warning('请设置价格调整')
        return
      }
      roomBatchEditDialog.saving = true
      try {
        const res = await api.post('/rooms/batch-edit', {
          store_id: f.store_id || undefined,
          room_category: f.room_category || undefined,
          floor: floorVal || undefined,
          set_base_price: setBase,
          delta_base_price: deltaBase,
          set_hourly_price: setHourly,
          delta_hourly_price: deltaHourly,
        })
        notify('已更新 ' + res.updated + ' 间房间的价格')
        roomBatchEditDialog.visible = false
        await Promise.all([loadRoomList(), loadAll()])
      } catch (e) { /* 拦截器已提示 */ } finally {
        roomBatchEditDialog.saving = false
      }
    }
    async function addRoomCategory() {
      try {
        const { value } = await ElMessageBox.prompt('请输入新房型名称', '新增房型', {
          confirmButtonText: '新增',
          cancelButtonText: '取消',
          inputPattern: /\S+/,
          inputErrorMessage: '名称不能为空',
        })
        await api.post('/room-categories', { name: String(value).trim() })
        notify('房型已新增')
        await loadRoomCategories()
      } catch (e) { /* 取消或拦截器提示 */ }
    }
    async function removeRoomCategory(cat) {
      if (!(await askConfirm({
        title: '删除房型',
        message: '确定删除房型「' + cat.name + '」吗？',
        confirmText: '删除',
      }))) return
      try {
        await api.delete('/room-categories/' + cat.id, { params: { confirm: true } })
        notify('房型已删除')
        await loadRoomCategories()
      } catch (e) { /* 拦截器已提示 */ }
    }

    // ---------- 自动维护 ----------
    async function loadAutoSettings() {
      try {
        const list = await api.get('/settings')
        autoMaster.value = (list.find((x) => x.key === 'auto_master') || {}).value === '1'
        autoSettings.checkin = (list.find((x) => x.key === 'auto_checkin') || {}).value === '1'
        autoSettings.checkout = (list.find((x) => x.key === 'auto_checkout') || {}).value === '1'
        autoSettings.extend = (list.find((x) => x.key === 'auto_extend') || {}).value === '1'
      } catch (e) { /* 忽略 */ }
    }
    async function toggleAutoMaster(val) {
      if (val) {
        const ok = await askConfirm({
          title: '开启自动维护',
          message: '开启后系统将按设置自动执行订单操作，涉及收款等敏感操作；自动维护不处理长租订单。开启前会自动备份当前数据，确认开启吗？',
          confirmText: '确认开启',
        })
        if (!ok) return
        try {
          await api.post('/backup/manual', null, { params: { reason: '自动维护前保留' } })
        } catch (e) { /* 备份失败不阻断 */ }
      }
      try {
        await api.put('/settings', { items: { auto_master: val ? '1' : '0' } })
        autoMaster.value = val
        notify(val ? '自动维护已开启' : '自动维护已关闭')
      } catch (e) { /* 拦截器已提示 */ }
    }
    async function toggleAutoSetting(key, val) {
      if (val && key === 'checkout' && autoSettings.extend) {
        const ok = await askConfirm({
          title: '功能冲突',
          message: '自动退房与自动续住存在冲突，仅启用自动退房并关闭自动续住？',
          confirmText: '仅启用退房',
        })
        if (!ok) { autoSettings.checkout = false; return }
        await api.put('/settings', { items: { auto_extend: '0' } }).catch(() => {})
        autoSettings.extend = false
      }
      if (val && key === 'extend' && autoSettings.checkout) {
        const ok = await askConfirm({
          title: '功能冲突',
          message: '自动续住与自动退房存在冲突，仅启用自动续住并关闭自动退房？',
          confirmText: '仅启用续住',
        })
        if (!ok) { autoSettings.extend = false; return }
        await api.put('/settings', { items: { auto_checkout: '0' } }).catch(() => {})
        autoSettings.checkout = false
      }
      try {
        await api.put('/settings', { items: { ['auto_' + key]: val ? '1' : '0' } })
        notify(val ? '已启用自动' + (key === 'checkin' ? '入住' : key === 'checkout' ? '退房' : '续住') : '已关闭')
      } catch (e) {
        autoSettings[key] = !val
      }
    }
    async function openAutoLogs() {
      await loadAutomationLogs()
      autoLogDialog.visible = true
    }
    async function loadAutomationLogs() {
      try { automationLogs.value = await api.get('/automation/logs') } catch (e) { automationLogs.value = [] }
    }
    async function rollbackAutomation(opts) {
      if (!(await askConfirm({
        title: '回滚自动化操作',
        message: '回滚后订单与收支将恢复到自动操作前的状态，并自动关闭对应自动维护功能。确定回滚吗？',
        confirmText: '确认回滚',
      }))) return
      try {
        const res = await api.post('/automation/rollback', {
          log_id: opts.logId,
          order_id: opts.orderId,
          confirm: true,
        })
        notify('已回滚 ' + res.rolled + ' 条自动操作')
        await loadAutomationLogs()
        if (detailDialog.visible && detailDialog.order) {
          detailDialog.order = await api.get('/orders/' + detailDialog.order.id)
        }
        await Promise.all([loadOrders(), loadAll(), loadRevenue()])
      } catch (e) { /* 拦截器已提示 */ }
    }
    function onAutoActionPick({ selectedOptions }) {
      if (selectedOptions && selectedOptions.length && detailDialog.order) {
        setOrderAutomation(detailDialog.order, detailDialog.order.auto_checkin_enabled === 1, true, selectedOptions[0].value)
      }
      autoActionPicker.value = false
    }
    const autoActionColumns = computed(() => [
      { text: '自动退房', value: 'checkout' },
      { text: '自动续住', value: 'extend' },
    ])
    async function setOrderAutomation(order, checkinEnabled, departEnabled, departAction) {
      try {
        const updated = await api.post('/orders/' + order.id + '/automation', {
          checkin_enabled: !!checkinEnabled,
          depart_enabled: !!departEnabled,
          depart_action: departAction || 'checkout',
        })
        if (detailDialog.order && detailDialog.order.id === updated.id) detailDialog.order = updated
        notify(checkinEnabled || departEnabled ? '已开启该订单自动维护' : '已关闭该订单自动维护')
      } catch (e) { /* 拦截器已提示 */ }
    }

    // ---------- 备份列表 / 读取备份 ----------
    const alerts = ref([])
    async function loadAlerts() {
      try { alerts.value = await api.get('/alerts', { params: { store_id: currentStoreId.value } }) } catch (e) { alerts.value = [] }
    }
    async function openAlertOrder(orderId) {
      try {
        const o = await api.get('/orders/' + orderId)
        openDetailByOrder(o)
      } catch (e) { /* 拦截器已提示 */ }
    }
    function orderStatusCls(s) {
      return { '已预订': 'st-booked', '已入住': 'st-in', '已退房': 'st-out', '已取消': 'st-cancel' }[s] || ''
    }
    function openBackupDialog() {
      loadBackups()
      backupDialog.visible = true
    }
    function backupReason(name) {
      return String(name || '').split('_')[0] || ''
    }
    function backupSize(kb) {
      return kb ? Math.max(1, Math.round(kb / 1024)) + ' KB' : ''
    }
    async function loadBackups() {
      try { backupList.value = await api.get('/backups') } catch (e) { backupList.value = [] }
    }
    function fmtDateTime(ts) {
      if (!ts) return ''
      const d = new Date(ts * 1000)
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    async function restoreBackup(file) {
      if (!(await askConfirm({
        title: '读取备份',
        message: '将先备份当前数据（读取备份前保留），再恢复为备份「' + file.name + '」的内容。确认恢复吗？',
        confirmText: '确认恢复',
      }))) return
      try {
        await api.post('/backup/restore', { backup_path: file.path })
        notify('备份已恢复')
        setTimeout(() => location.reload(), 900)
      } catch (e) { /* 拦截器已提示 */ }
    }

    async function deleteBackup(file) {
      if (!(await askConfirm({
        title: '删除备份',
        message: '确定删除备份「' + file.name + '」吗？删除后不可恢复。',
        confirmText: '删除',
      }))) return
      try {
        await api.post('/backup/delete', { backup_path: file.path })
        notify('备份已删除')
        await loadBackups()
      } catch (e) { /* 拦截器已提示 */ }
    }

    // 钟点价上限自动等同全日价：全日价下调时同步压缩钟点价
    watch(() => roomDialog.form.base_price, (v) => {
      const b = Number(v) || 0
      const h = Number(roomDialog.form.hourly_price) || 0
      if (h > b) roomDialog.form.hourly_price = b
    })

    async function toggleRoomActive(row, val) {
      if (!val && (row.active_orders || 0) > 0) {
        const ok = await askConfirm({
          title: '停用房间',
          message: '该房间存在进行中订单，停用后请留意订单处理。仍要停用吗？',
          confirmText: '确认停用',
        })
        if (!ok) return
      }
      try {
        await api.put('/rooms/' + row.id, { is_active: val ? 1 : 0 })
        row.is_active = val ? 1 : 0
        notify(row.is_active ? '房间已启用' : '房间已停用')
        await loadAll()
      } catch (e) { /* 拦截器已提示 */ }
    }
    async function toggleRoomRepair(row, val) {
      const target = val ? '维修' : '空闲'
      if ((row.active_orders || 0) > 0) {
        const ok = await askConfirm({
          title: '切换状态',
          message: '该房间存在进行中订单，切换状态后请留意订单处理。仍要切换为「' + target + '」吗？',
          confirmText: '确认切换',
        })
        if (!ok) return
      }
      try {
        const resp = await api.put('/rooms/' + row.id, { status: target })
        row.status = resp.status
        notify(row.status === '维修' ? '房间已设为维修' : '房间状态已恢复为「' + row.status + '」')
        await loadAll()
      } catch (e) { /* 拦截器已提示 */ }
    }

    async function toggleRoomClean(row, val) {
      try {
        await api.put('/rooms/' + row.id, { need_clean: val ? 1 : 0 })
        row.need_clean = val ? 1 : 0
        notify(val ? '房间已标记为需打扫' : '房间已标记为已打扫')
        await loadAll()
      } catch (e) { row.need_clean = val ? 0 : 1; /* 拦截器已提示 */ }
    }

    async function saveRoom() {
      const f = roomDialog.form
      if (!f.room_number.trim()) { ElMessage.warning('请填写房间号'); return }

      if (!(Number(f.base_price) >= 0)) { ElMessage.warning('请填写价格'); return }
      if (!(Number(f.hourly_price) >= 0)) { ElMessage.warning('请填写钟点房价格'); return }
      if (roomDialog.isEdit && f.status !== roomDialog.origStatus
          && (roomDialog.origActiveOrders || 0) > 0) {
        const ok = await askConfirm({
          title: '切换状态',
          message: '该房间存在进行中订单，切换状态后请留意订单处理。仍要保存为「' + f.status + '」吗？',
          confirmText: '确认切换',
        })
        if (!ok) return
      }
      const payload = {
        room_number: f.room_number.trim(),

        room_category: f.room_category,
        base_price: Number(f.base_price),
        hourly_price: Math.min(Number(f.hourly_price) || 0, Number(f.base_price) || 0),
        remark: (f.remark || '').trim(),
        status: f.status,
        store_id: f.store_id || currentStoreId.value,
      }
      if (roomDialog.isEdit) payload.is_active = f.is_active ? 1 : 0
      roomDialog.saving = true
      try {
        if (roomDialog.isEdit) {
          await api.put('/rooms/' + roomDialog.id, payload)
          notify('房间已更新')
        } else {
          await api.post('/rooms', payload)
          notify('房间已添加')
        }
        roomDialog.visible = false
        await Promise.all([loadRoomList(), loadAll()])
      } catch (e) { /* 拦截器已提示 */ } finally {
        roomDialog.saving = false
      }
    }

    async function removeRoom(row) {
      if (row.is_active) {
        // 正常房间：删除 = 停用（软删除，可恢复）
        if (!(await askConfirm({
          title: '停用房间',
          message: '确定停用房间 ' + row.room_number + '（' + row.room_category + '）吗？'
            + '停用后可在房间筛选“停用”中查看并恢复，历史订单不受影响。',
          confirmText: '停用',
        }))) return
        try {
          await api.delete('/rooms/' + row.id, { params: { confirm: true } })
          notify('房间已停用')
          await Promise.all([loadRoomList(), loadAll()])
        } catch (e) { /* 拦截器已提示 */ }
      } else {
        // 已停用房间：彻底删除（不可恢复）
        if (!(await askConfirm({
          title: '彻底删除房间',
          message: '确定彻底删除房间 ' + row.room_number + '（' + row.room_category + '）吗？'
            + '彻底删除后不可恢复（如该房间存在历史订单则无法删除）。',
          confirmText: '彻底删除',
        }))) return
        try {
          await api.delete('/rooms/' + row.id, { params: { confirm: true, hard: true } })
          notify('房间已彻底删除')
          await Promise.all([loadRoomList(), loadAll()])
        } catch (e) { /* 拦截器已提示 */ }
      }
    }

    async function loadOrders() {
      orderListLoading.value = true
      try {
        const params = {}
        // 输入客人姓名/手机号/订单号关键词时：忽略日期范围，全时段搜索（便于跨月查找客人）
        const hasKeyword = !!orderFilters.keyword.trim()
        const range = hasKeyword ? null : orderRange()
        if (range) {
          params.date_from = range[0]
          params.date_to = range[1]
          // 单日查询按占用期重叠展示；年/月/自定义按订单起始日期归属
          params.date_mode = orderFilters.gran === 'day' ? 'overlap' : 'start'
        }
        if (orderFilters.room_number.trim()) params.room_number = orderFilters.room_number.trim()
        if (orderFilters.keyword.trim()) params.keyword = orderFilters.keyword.trim()
        if (orderFilters.order_type && orderFilters.order_type !== 'all') params.order_type = orderFilters.order_type
        if (orderFilters.source !== 'all') params.guest_source = orderFilters.source
        params.store_id = orderStoreFilter.value === 'all' ? undefined : orderStoreFilter.value
        orderList.value = await api.get('/orders', { params })
      } finally {
        orderListLoading.value = false
      }
    }

    function resetOrders() {
      orderFilters.gran = 'all'
      orderFilters.year = new Date().getFullYear()
      orderFilters.month = new Date().getMonth() + 1
      orderFilters.day = Date.now()
      orderFilters.range = null
      orderFilters.room_number = ''
      orderFilters.keyword = ''
      orderFilters.order_type = 'all'
      orderFilters.source = 'all'
      loadOrders()
    }

    function switchView(view) {
      activeView.value = view
      if (view === 'orders') loadOrders()
      else if (view === 'settings') { loadDbInfo(); loadBackups(); loadAutomationLogs(); loadAutoSettings(); loadRoomCategories() }
      else if (view === 'rooms') loadRoomList()
      else if (view === 'revenue') loadRevenue()
      else loadAll()
    }

    // ---------- 收入查看 ----------
    const revenueData = ref(null)
    const revenueLoading = ref(false)
    const revenueFilters = reactive({
      store_id: null,
      gran: 'day',
      keyword: '',
      year: new Date().getFullYear(),
      month: new Date().getMonth() + 1,
      day: Date.now(),
      range: null,
      repay: 'all',
      source: 'all',
      filter: 'all',
    })
    const revenueYears = computed(() => {
      // 起始年份固定 2026，随系统日期自动增加一年
      const list = []
      const end = new Date().getFullYear() + 1
      for (let y = 2026; y <= end; y++) list.push(y)
      return list
    })

    function revenueRange() {
      const f = revenueFilters
      if (f.gran === 'all') {
        if (f.range && f.range.length === 2) {
          return [
            Math.floor(Number(f.range[0]) / 1000),
            Math.floor(Number(f.range[1]) / 1000) + 86399,
          ]
        }
        return null
      }
      const y0 = (y) => Math.floor(new Date(y, 0, 1).getTime() / 1000)
      if (f.gran === 'year') {
        return [y0(Number(f.year)), Math.floor(new Date(Number(f.year) + 1, 0, 1).getTime() / 1000)]
      }
      if (f.gran === 'month') {
        return [
          Math.floor(new Date(Number(f.year), Number(f.month) - 1, 1).getTime() / 1000),
          Math.floor(new Date(Number(f.year), Number(f.month), 1).getTime() / 1000),
        ]
      }
      if (f.gran === 'day') {
        const daySec = dayStart(Math.floor((Number(f.day) || Date.now()) / 1000))
        return [daySec, daySec + 86400]
      }
      if (f.range && f.range.length === 2) {
        return [
          Math.floor(Number(f.range[0]) / 1000),
          Math.floor(Number(f.range[1]) / 1000) + 86399,
        ]
      }
      return [0, 0]
    }

    async function loadRevenue() {
      const range = revenueRange()
      if (range && !range[0] && !range[1]) {
        revenueData.value = null
        return
      }
      revenueLoading.value = true
      try {
        revenueData.value = await api.get('/statistics/revenue', {
          params: {
            start_ts: range ? range[0] : undefined,
            end_ts: range ? range[1] : undefined,
            store_id: revenueFilters.store_id || undefined,
            gran: revenueFilters.gran,
            keyword: revenueFilters.keyword.trim() || undefined,
            repay: revenueFilters.filter === 'repaid' ? '已回款' : (revenueFilters.filter === 'pending' ? '待回款' : ''),
            kind_filter: revenueFilters.filter === 'income' || revenueFilters.filter === 'repaid' || revenueFilters.filter === 'pending' ? 'income' : (revenueFilters.filter === 'expense' ? 'expense' : ''),
            guest_source: revenueFilters.source === 'all' ? undefined : revenueFilters.source,
          },
        })
      } finally {
        revenueLoading.value = false
      }
    }

    // ---------- 手动收支管理 ----------
    const expenseDialog = reactive({
      visible: false, saving: false, isEdit: false, id: null,
      kind: 'expense', date: Date.now(), reason: '', amount: 0, remark: '',
    })
    const entryDetail = reactive({ visible: false, entry: null })

    function openAddExpense() {
      expenseDialog.isEdit = false
      expenseDialog.id = null
      expenseDialog.kind = 'expense'
      expenseDialog.date = Date.now()
      expenseDialog.reason = ''
      expenseDialog.amount = 0
      expenseDialog.remark = ''
      expenseDialog.visible = true
    }

    function openEditExpense(entry) {
      expenseDialog.isEdit = true
      expenseDialog.id = entry.expense_id
      expenseDialog.kind = entry.kind || 'expense'
      expenseDialog.date = (entry.checkout_time || Date.now() / 1000) * 1000
      expenseDialog.reason = entry.reason || ''
      expenseDialog.amount = entry.kind === 'income' ? entry.income : entry.expense
      expenseDialog.remark = entry.remark || ''
      expenseDialog.visible = true
    }

    async function saveExpense() {
      if (!expenseDialog.reason.trim()) { ElMessage.warning('请填写收支摘要/理由'); return }
      if (!(Number(expenseDialog.amount) > 0)) { ElMessage.warning('请填写支出金额'); return }
      expenseDialog.saving = true
      try {
        const payload = {
          kind: expenseDialog.kind,
          expense_date: Math.floor(Number(expenseDialog.date) / 1000),
          reason: expenseDialog.reason.trim(),
          amount: Number(expenseDialog.amount),
          remark: expenseDialog.remark.trim(),
          store_id: revenueFilters.store_id || currentStoreId.value || 1,
        }
        if (expenseDialog.isEdit) {
          await api.put('/expenses/' + expenseDialog.id, payload)
          notify('已更新')
        } else {
          await api.post('/expenses', payload)
          notify('已记录')
        }
        expenseDialog.visible = false
        await loadRevenue()
      } catch (e) { /* 拦截器已提示 */ } finally {
        expenseDialog.saving = false
      }
    }

    function openEntryDetail(row) {
      entryDetail.entry = row
      entryDetail.visible = true
    }

    async function removeExpense() {
      const row = entryDetail.entry
      if (!(await askConfirm({
        title: '删除记录',
        message: '确定删除该笔收支记录吗？删除后不可恢复。',
        confirmText: '删除',
      }))) return
      try {
        await api.delete('/expenses/' + row.expense_id, { params: { confirm: true } })
        notify('已删除')
        entryDetail.visible = false
        await loadRevenue()
      } catch (e) { /* 拦截器已提示 */ }
    }

    function onRevenueRowClick(row) {
      const g = revenueFilters.gran
      if (!row) return
      if (g === 'day' || g === 'all') {
        // 手动收支：打开详情（含编辑/删除）；订单收支：直接打开订单详情
        if (row.expense_id) openEntryDetail(row)
        else if (row.order_id) openDetailById(row.order_id)
        return
      }
      if (g === 'year') {
        const parts = row.period.split('-').map(Number)
        revenueFilters.gran = 'month'
        revenueFilters.year = parts[0]
        revenueFilters.month = parts[1]
      } else {
        const parts = row.period.split('-').map(Number)
        revenueFilters.gran = 'day'
        revenueFilters.day = new Date(parts[0], parts[1] - 1, parts[2]).getTime()
      }
      loadRevenue()
    }

    // 手机端：收支页整体左右滑动快速切换前后时间
    const revenueTouch = { x: 0, y: 0, t: 0 }
    function onRevenueTouchStart(evt) {
      const t = evt.touches ? evt.touches[0] : evt
      revenueTouch.x = t.clientX
      revenueTouch.y = t.clientY
      revenueTouch.t = Date.now()
    }
    function onRevenueTouchEnd(evt) {
      const t = evt.changedTouches ? evt.changedTouches[0] : evt
      const dx = t.clientX - revenueTouch.x
      const dy = t.clientY - revenueTouch.y
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2
          || Date.now() - revenueTouch.t > 600) return
      revenueShift(dx < 0 ? 1 : -1)
    }
    function revenueShift(delta) {
      const f = revenueFilters
      if (f.gran === 'day') {
        const sec = dayStart(Math.floor((Number(f.day) || Date.now()) / 1000))
        f.day = (sec + delta * 86400) * 1000
      } else if (f.gran === 'month') {
        const d = new Date(Number(f.year), Number(f.month) - 1 + delta, 1)
        f.year = d.getFullYear()
        f.month = d.getMonth() + 1
      } else if (f.gran === 'year') {
        f.year = Number(f.year) + delta
      } else if (f.gran === 'custom' && f.range && f.range.length === 2) {
        const span = Number(f.range[1]) - Number(f.range[0])
        const next0 = Number(f.range[0]) + delta * span
        f.range = [next0, next0 + span]
      }
      loadRevenue()
    }
    function revenueBack() {
      const f = revenueFilters
      if (f.gran === 'day') {
        const d = new Date(Number(f.day) || Date.now())
        f.gran = 'month'
        f.year = d.getFullYear()
        f.month = d.getMonth() + 1
      } else if (f.gran === 'month') {
        f.gran = 'year'
      } else if (f.gran === 'custom' && f.range && f.range.length === 2) {
        const d = new Date(Number(f.range[0]))
        f.gran = 'month'
        f.year = d.getFullYear()
        f.month = d.getMonth() + 1
      } else {
        return
      }
      loadRevenue()
    }

    // ---------- 入住渠道管理 ----------
    const channelDialog = reactive({
      visible: false, isEdit: false, id: null, saving: false,
      name: '', color: CHANNEL_COLORS[0],
      repay_type: 'direct', repay_days: 3, repay_weekday: 1, repay_monthday: 1,
    })

    function openAddChannel() {
      channelDialog.isEdit = false
      channelDialog.id = null
      channelDialog.name = ''
      channelDialog.color = CHANNEL_COLORS[0]
      channelDialog.repay_type = 'direct'
      channelDialog.repay_days = 3
      channelDialog.repay_weekday = 1
      channelDialog.repay_monthday = 1
      channelDialog.visible = true
    }

    function openEditChannel(c) {
      channelDialog.isEdit = true
      channelDialog.id = c.id
      channelDialog.name = c.name
      channelDialog.color = c.color
      channelDialog.repay_type = c.repay_type || 'direct'
      channelDialog.repay_days = c.repay_days || 0
      channelDialog.repay_weekday = c.repay_weekday || 1
      channelDialog.repay_monthday = c.repay_monthday || 1
      channelDialog.visible = true
    }

    function repayRuleLabel(c) {
      if (!c) return ''
      if (c.repay_type === 'days') return (c.repay_days || 0) + ' 日后到账'
      if (c.repay_type === 'week') return '每周' + '一二三四五六日'[(c.repay_weekday || 1) - 1] + '到账'
      if (c.repay_type === 'month') return '每月' + (c.repay_monthday || 1) + ' 号到账'
      return '直接到账'
    }

    async function saveChannel() {
      const name = channelDialog.name.trim()
      if (!name) { ElMessage.warning('请输入渠道名称'); return }
      channelDialog.saving = true
      try {
        if (channelDialog.isEdit) {
          await api.put('/channels/' + channelDialog.id, { name, color: channelDialog.color,
            repay_type: channelDialog.repay_type, repay_days: Number(channelDialog.repay_days) || 0,
            repay_weekday: Number(channelDialog.repay_weekday) || 1, repay_monthday: Number(channelDialog.repay_monthday) || 1 })
          notify('渠道已更新')
        } else {
          await api.post('/channels', { name, color: channelDialog.color,
            repay_type: channelDialog.repay_type, repay_days: Number(channelDialog.repay_days) || 0,
            repay_weekday: Number(channelDialog.repay_weekday) || 1, repay_monthday: Number(channelDialog.repay_monthday) || 1 })
          notify('渠道已新增')
        }
        channelDialog.visible = false
        await loadChannels()
        await loadAll()
      } catch (e) { /* 拦截器已提示 */ } finally {
        channelDialog.saving = false
      }
    }

    async function removeChannel(c) {
      if (!(await askConfirm({
        title: '删除渠道',
        message: '确定删除入住渠道「' + c.name + '」吗？已有订单不受影响。',
        confirmText: '删除',
      }))) return
      try {
        await api.delete('/channels/' + c.id, { params: { confirm: true } })
        notify('渠道已删除')
        await loadChannels()
        await loadAll()
      } catch (e) { /* 拦截器已提示 */ }
    }

    // ---------- 新建订单 ----------
    const orderDialog = reactive({
      visible: false, saving: false,
      form: {
        room_id: null,
        order_type: 'full_day',
        settle_mode: 'ondeparture',
        daily_price: 0,
        dailyPriceTouched: false,
        checkin_date: 0, // 入住日期（ms）
        checkout_date: 0, // 离店日期（ms）
        checkin_hm: '14:00', // 入住时间（HH:MM）
        checkout_hm: '12:00', // 离店时间（HH:MM）
        rent_hours: 2,
        guest_name: '',
        guest_phone: '',
        guest_source: '线下',
        remark: '',
        price: 0,
        priceTouched: false,
      },
    })
    const availableRooms = ref([])
    const availableLoading = ref(false)
    const pendingPreselect = ref(null)

    function orderStartSec() {
      const f = orderDialog.form
      const d = Number(f.checkin_date)
      return d ? Math.floor(d / 1000) + hmToSec(f.checkin_hm) : 0
    }
    function orderEndSec() {
      const f = orderDialog.form
      if (f.order_type === 'full_day' || f.order_type === 'long_term') {
        const d = Number(f.checkout_date)
        return d ? Math.floor(d / 1000) + hmToSec(f.checkout_hm) : 0
      }
      const s = orderStartSec()
      return s ? s + (Number(f.rent_hours) || 0) * 3600 : 0
    }

    const selectedRoom = computed(() => {
      const rid = orderDialog.form.room_id
      return availableRooms.value.find((r) => r.id === rid)
        || rooms.value.find((r) => r.id === rid) || null
    })
    const noRoom = computed(() =>
      !availableLoading.value && availableRooms.value.length === 0)

    const suggestedPrice = computed(() => {
      const room = selectedRoom.value
      if (!room) return 0
      const s = orderStartSec()
      const e = orderEndSec()
      if (!s || !e || e <= s) return 0
      if (orderDialog.form.order_type === 'full_day' || orderDialog.form.order_type === 'long_term') {
        const days = Math.max(1, Math.ceil((e - s) / 86400))
        const dailyPrice = Number(orderDialog.form.daily_price) || 0
        const rate = dailyPrice || room.base_price
        return Math.round(days * rate * 100) / 100
      }
      // 钟点房自动计费：按日租原价计费，至少一晚；每超过一个次日 12:00 多收一晚
      const nights = hourlyNights(s, s + (Number(orderDialog.form.rent_hours) || 0) * 3600)
      return Math.round((room.base_price || 0) * nights * 100) / 100
    })

    function roomOptionLabel(r) {
      const t = orderDialog.form.order_type
      const base = r.room_number + ' ' + r.room_category + ' · '
      if (t === 'hourly') return base + '钟点¥' + r.base_price + '/晚'
      if (t === 'long_term') return base + '长租¥' + r.base_price + '/日'
      return base + '全日¥' + r.base_price + '/日'
    }

    function sourceIsDirect(src) {
      if (!src) return true
      const ch = channels.value.find((c) => c.name === src)
      return !ch || ch.repay_type === 'direct'
    }
    // 日租/钟点房：非直接到账渠道不可选先付，自动切换为退房结算
    function syncSettleByChannel() {
      const f = orderDialog.form
      if (f.order_type !== 'long_term' && f.settle_mode === 'once' && !sourceIsDirect(f.guest_source)) {
        f.settle_mode = 'ondeparture'
      }
    }
    function onOrderTypeChange() {
      const f = orderDialog.form
      const t = f.order_type
      if (t === 'long_term' && !['once', 'daily', 'ondeparture'].includes(f.settle_mode)) f.settle_mode = 'daily'
      // 日租与钟点房默认退房结算
      if (t !== 'long_term' && !['once', 'ondeparture'].includes(f.settle_mode)) f.settle_mode = 'ondeparture'
      syncSettleByChannel()
      syncPrice()
      fetchAvailableRooms()
    }

    function syncPrice() {
      const f = orderDialog.form
      const room = selectedRoom.value
      // 日租/长租：选中房间后自动带入房间基础价作为每日单价
      if ((f.order_type === 'full_day' || f.order_type === 'long_term')
          && !f.dailyPriceTouched && !f.daily_price && room) {
        f.daily_price = Number(room.base_price) || 0
      }
      if (!orderDialog.form.priceTouched) {
        orderDialog.form.price = suggestedPrice.value
      }
    }

    function onDailyPriceChange() {
      orderDialog.form.dailyPriceTouched = true
      syncPrice()
    }

    async function fetchAvailableRooms() {
      const s = orderStartSec()
      const e = orderEndSec()
      if (!s || !e || e <= s) {
        availableRooms.value = []
        return
      }
      availableLoading.value = true
      try {
        const list = await api.get('/available-rooms', {
          params: { start_ts: s, end_ts: e, store_id: currentStoreId.value },
        })
        availableRooms.value = list
        const f = orderDialog.form
        if (f.room_id && !list.some((r) => r.id === f.room_id)) f.room_id = null
        if (!f.room_id && pendingPreselect.value
          && list.some((r) => r.id === pendingPreselect.value)) {
          f.room_id = pendingPreselect.value
        }
        pendingPreselect.value = null
        syncPrice()
      } catch (e) {
        availableRooms.value = []
      } finally {
        availableLoading.value = false
      }
    }

    function openCreateOrder(room, day) {
      const dayMs = day.ts * 1000
      pendingPreselect.value = room ? room.id : null
      // 部分占用的一天：自动预填第一个空闲时段（钟点房），其余时间仍可操作
      const segs = activeSegs(room, day)
      const freeStart = segs.length ? pickFreeStart(segs, day.ts) : null
      orderDialog.form = {
        room_id: null,
        order_type: freeStart ? 'hourly' : 'full_day',
        settle_mode: 'ondeparture',
        daily_price: 0,
        dailyPriceTouched: false,
        checkin_date: dayMs,
        checkout_date: dayMs + 86400000,
        checkin_hm: freeStart ? fmtHM(freeStart) : '14:00',
        checkout_hm: '12:00',
        rent_hours: 2,
        guest_name: '',
        guest_phone: '',
        remark: '',
        price: 0,
        priceTouched: false,
      }
      orderDialog.visible = true
      fetchAvailableRooms()
    }

    function resetPrice() {
      orderDialog.form.price = suggestedPrice.value
      orderDialog.form.priceTouched = false
    }

    function validateOrder() {
      const f = orderDialog.form
      if (!f.room_id) return '请选择房间'
      if (f.order_type === 'full_day' && !f.checkin_date) return '请选择入住日期'
      if (f.order_type === 'full_day' && !f.checkout_date) return '请选择离店日期'
      if (f.order_type === 'hourly' && !f.checkin_date) return '请选择入住日期'
      const s = orderStartSec()
      const e = orderEndSec()
      if (!s || !e || e <= s) return '离店/结束时间必须晚于入住时间'
      return null
    }

    async function saveOrder() {
      const errMsg = validateOrder()
      if (errMsg) { ElMessage.warning(errMsg); return }
      const f = orderDialog.form
      const payload = {
        room_id: f.room_id,
        order_type: f.order_type,
        settle_mode: f.settle_mode || 'once',
        daily_price: Number(f.daily_price) || 0,
        guest_name: f.guest_name.trim(),
        guest_phone: f.guest_phone.trim(),
        guest_source: (f.guest_source || '').trim(),
        remark: (f.remark || '').trim(),
        start_timestamp: orderStartSec(),
        total_price: Number(f.price),
        status: '已预订',
      }
      if (f.order_type === 'full_day' || f.order_type === 'long_term') {
        payload.end_timestamp = orderEndSec()
      } else {
        payload.rent_hours = Number(f.rent_hours)
      }

      orderDialog.saving = true
      try {
        const created = await api.post('/orders', payload)
        notify('订单已创建，订单号 ' + created.order_no)
        orderDialog.visible = false
        await loadAll()
        if (activeView.value === 'orders') await loadOrders()
      } catch (e) { /* 拦截器已提示 */ } finally {
        orderDialog.saving = false
      }
    }

    // 计费方式 / 日期 / 时长变化 → 自动刷新可用房间并同步价格
    watch(
      () => [orderDialog.form.order_type, orderStartSec(), orderEndSec(), orderDialog.form.rent_hours],
      () => {
        if (!orderDialog.visible) return
        syncPrice()
        fetchAvailableRooms()
      }
    )
    // 切换房间：未手动修改每日单价时自动跟随新房间基础价
    watch(
      () => orderDialog.form.room_id,
      (rid) => {
        if (!orderDialog.visible || orderDialog.form.dailyPriceTouched) return
        const room = availableRooms.value.find((r) => r.id === rid)
        if (room && (orderDialog.form.order_type === 'full_day' || orderDialog.form.order_type === 'long_term')) {
          orderDialog.form.daily_price = Number(room.base_price) || 0
          syncPrice()
        }
      }
    )
    // 每日单价变化：自动重算总价（未手动修改总价时）
    watch(
      () => orderDialog.form.daily_price,
      () => {
        if (!orderDialog.visible) return
        syncPrice()
      }
    )
    // 入住日期变更时，离店日期自动跟随（保持原入住天数）
    watch(
      () => orderDialog.form.checkin_date,
      (nv, ov) => {
        if (!orderDialog.visible || !nv || !ov) return
        const f = orderDialog.form
        if (f.order_type !== 'full_day' && f.order_type !== 'long_term') return
        const diff = Math.round((Number(f.checkout_date) - Number(ov)) / 86400000)
        if (diff > 0) f.checkout_date = Number(nv) + diff * 86400000
      }
    )

    // ---------- 订单详情与操作 ----------
    const detailDialog = reactive({ visible: false, order: null, loading: false, payments: [], segments: [] })
    const detailPayDay = ref(0)
    const detailPayAmount = ref(0)
    const detailPaySaving = ref(false)
    const checkoutDialog = reactive({ visible: false, order: null, amount: 0, refund: 0, endDate: Date.now(), endTime: '12:00', saving: false })
    const cancelDialog = reactive({ visible: false, order: null, refund: 0, saving: false })
    
    const extendDialog = reactive({ visible: false, order: null, count: 1, amount: 0, amountTouched: false, saving: false })
    const orderEdit = reactive({
      enabled: false, saving: false, settled: false,
      form: {
        room_id: null, order_type: 'full_day', guest_name: '', guest_phone: '',
        guest_source: '', remark: '', start_timestamp: 0, end_timestamp: 0,
        rent_hours: 1, total_price: 0, priceTouched: false, status: '已预订',
      },
    })
    const orderEditRooms = computed(() => {
      const list = [...rooms.value]
      const cur = detailDialog.order
      if (cur && !list.some((r) => r.id === cur.room_id)) {
        list.push({
          id: cur.room_id, room_number: cur.room_number, room_name: cur.room_name || '', room_category: cur.room_category || '',
          room_category: cur.room_category || '', base_price: cur.base_price || 0,
          hourly_price: cur.hourly_price || 0,
        })
      }
      return list
    })

    // 订单编辑：按时间/房间/计费方式自动重算金额（未手动改金额时联动）
    const orderEditSuggested = computed(() => {
      const f = orderEdit.form
      if (!f || !f.start_timestamp) return 0
      const room = orderEditRooms.value.find((r) => r.id === f.room_id) || {}
      const base = Number(room.base_price) || 0
      if (f.order_type === 'hourly') {
        const sSec = Math.floor(Number(f.start_timestamp) / 1000)
        const eSec = sSec + (Number(f.rent_hours) || 0) * 3600
        return Math.round(base * hourlyNights(sSec, eSec) * 100) / 100
      }
      const s = Math.floor(Number(f.start_timestamp) / 1000)
      const e = Math.floor(Number(f.end_timestamp) / 1000)
      if (!s || !e || e <= s) return 0
      const days = Math.max(1, Math.ceil((e - s) / 86400))
      // 优先使用订单内日单价；切换房间后使用新房间基础价
      const cur = detailDialog.order
      const dailyRate = (cur && cur.room_id === f.room_id && Number(cur.daily_price))
        ? Number(cur.daily_price) : base
      return Math.round(days * (dailyRate || base) * 100) / 100
    })

    watch(
      () => [
        orderEdit.form.room_id, orderEdit.form.order_type,
        orderEdit.form.start_timestamp, orderEdit.form.end_timestamp, orderEdit.form.rent_hours,
      ],
      () => {
        if (!orderEdit.enabled || orderEdit.form.priceTouched) return
        // 打开编辑弹窗时的首次触发不重算，仅用户实际改动后才联动金额
        if (!orderEdit.settled) {
          orderEdit.settled = true
          return
        }
        orderEdit.form.total_price = orderEditSuggested.value
      }
    )

    watch(
      () => [orderEdit.form.start_date, orderEdit.form.start_hm],
      () => {
        if (!orderEdit.enabled) return
        const d = Number(orderEdit.form.start_date)
        if (d) orderEdit.form.start_timestamp = Math.floor(d / 1000) + hmToSec(orderEdit.form.start_hm)
      }
    )
    watch(
      () => [orderEdit.form.end_date, orderEdit.form.end_hm],
      () => {
        if (!orderEdit.enabled) return
        const d = Number(orderEdit.form.end_date)
        if (d) orderEdit.form.end_timestamp = Math.floor(d / 1000) + hmToSec(orderEdit.form.end_hm)
      }
    )
    function orderEditResetPrice() {
      orderEdit.form.priceTouched = false
      orderEdit.form.total_price = orderEditSuggested.value
    }


    function onCellClick(room, day) {
      if (room.status === '维修') {
        ElMessage.info(room.room_number + ' ' + day.date + ' 为维修/锁房状态')
        return
      }
      // 点击空白区域（非占用段）→ 新建订单，空闲时段可继续操作
      openCreateOrder(room, day)
    }

    const segTitle = "订单续住分段回款"
    const segKindLabel = (s) => (s && s.kind === "orig") ? "原订单" : "续住"
    const segSettleLabel = (s) => "结算 " + fmtDate(s && s.settle_date)
    const segRepayLabel = (s) => (s && s.repay_status === "已回款") ? "已回款" : ((s && s.repay_status === "待回款") ? "待回款" : "待结算")
    const segExpLabel = (s) => "预计 " + fmtDate(s && s.expected_repay_date) + " 回款"

    async function openDetailById(orderId, payDay) {
      try {
        const order = await api.get('/orders/' + orderId)
        openDetailByOrder(order, payDay)
      } catch (e) { /* 拦截器已提示 */ }
    }

    async function openDetail(room, day) {
      detailDialog.loading = true
      try {
        const list = await api.get('/orders', {
          params: { room_id: room.id, date_from: day.ts, date_to: day.ts + 86400 },
        })
        const order = list.find((o) => o.status === '已入住' || o.status === '已预订') || list[0]
        if (!order) {
          ElMessage.info('该日期没有找到订单')
          return
        }
        openDetailByOrder(order, day.ts)
      } finally {
        detailDialog.loading = false
      }
    }

    function openDetailByOrder(order, payDay) {
      orderEdit.enabled = false // 下次打开始终为订单信息展示，而非编辑页
      api.get('/orders/' + order.id + '/segments').then((s) => { if (detailDialog.order && detailDialog.order.id === order.id) detailDialog.segments = s || [] }).catch(() => {})
      detailDialog.order = order
      detailDialog.visible = true
      if (order && order.order_type === 'long_term' && order.settle_mode === 'daily') {
        // 只接受数字时间戳（订单表格 row-click 会传入 column 对象，需过滤）
        let pDay = (typeof payDay === 'number' && payDay > 0) ? payDay : undefined
        // 退房日区域并入前一天：点击退房日时收款日期选中前一天
        if (pDay) {
          const checkoutDay = dayStart(order.end_timestamp)
          if (checkoutDay > dayStart(order.start_timestamp) && dayStart(pDay) === checkoutDay) {
            pDay = checkoutDay - 86400
          }
        }
        loadDetailPayments(order, pDay)
      } else {
        detailDialog.payments = []
      }
    }
    async function loadDetailPayments(order, payDay) {
      try {
        const list = await api.get('/orders/' + order.id + '/payments')
        detailDialog.payments = list
        const daily = Number(order.daily_price) || Number(order.base_price) || 0
        let target = dayStart(Date.now() / 1000)
        if (typeof payDay === 'number' && payDay > 0) {
          target = dayStart(payDay)
        } else {
          // 订单页进入：默认选择订单第一天（异常起始时间回退到当天）
          target = dayStart(order.start_timestamp)
          if (!Number.isFinite(target) || target < 946684800) target = dayStart(Date.now() / 1000)
        }
        detailPayDay.value = target
        const rec = list.find((x) => x.pay_date === target && x.amount > 0)
        detailPayAmount.value = rec ? rec.amount : daily
      } catch (e) {
        detailDialog.payments = []
      }
    }
    async function saveDetailPayment() {
      const o = detailDialog.order
      if (!o || !detailPayDay.value) return
      detailPaySaving.value = true
      try {
        await api.post('/orders/' + o.id + '/payments', {
          pay_date: detailPayDay.value,
          amount: Number(detailPayAmount.value),
        })
        notify('已标记当日收款')
        await loadDetailPayments(o, detailPayDay.value)
        await Promise.all([loadAll(), loadOrders()])
      } catch (e) { /* 拦截器已提示 */ } finally {
        detailPaySaving.value = false
      }
    }

    async function doCheckin() {
      const o = detailDialog.order
      if (!(await askConfirm({
        title: '办理入住',
        message: '确认客人「' + o.guest_name + '」入住房间 ' + o.room_number + '？',
        confirmText: '确认入住',
      }))) return
      try {
        await api.post('/orders/' + o.id + '/checkin')
        notify('已办理入住')
        detailDialog.visible = false
        await loadAll()
        if (activeView.value === 'orders') await loadOrders()
      } catch (e) { /* 拦截器已提示 */ }
    }

    function openCancel() {
      cancelDialog.order = detailDialog.order
      cancelDialog.refund = 0
      cancelDialog.visible = true
    }

    async function confirmCancel() {
      const o = cancelDialog.order
      cancelDialog.saving = true
      try {
        const updated = await api.post('/orders/' + o.id + '/cancel', {
          refund_amount: Number(cancelDialog.refund) || 0,
          confirm: true,
        })
        notify('订单已取消' + ((Number(cancelDialog.refund) || 0) > 0 ? '，已退回 ' + fmtMoney(cancelDialog.refund) : ''))
        cancelDialog.visible = false
        detailDialog.visible = false
        await loadAll()
        if (activeView.value === 'orders') await loadOrders()
      } catch (e) { /* 拦截器已提示 */ } finally {
        cancelDialog.saving = false
      }
    }

    function openCheckout() {
      checkoutDialog.order = detailDialog.order
      // 日结订单：默认实收按“目前已收取金额”计算，而非订单预期总价
      checkoutDialog.amount = detailDialog.order.settle_mode === 'daily'
        ? Number(detailDialog.order.recorded_income || 0)
        : Number(detailDialog.order.total_price || 0)
      checkoutDialog.refund = 0
      const nowD = new Date()
      checkoutDialog.endDate = Date.now()
      checkoutDialog.endTime = pad(nowD.getHours()) + ':' + pad(nowD.getMinutes())
      checkoutDialog.visible = true
    }

    async function confirmCheckout() {
      const o = checkoutDialog.order
      checkoutDialog.saving = true
      try {
        const updated = await api.post('/orders/' + o.id + '/checkout', {
          confirm: true,
          total_price: Number(checkoutDialog.amount),
          refund_amount: Number(checkoutDialog.refund) || 0,
          end_timestamp: dayStart(Math.floor(Number(checkoutDialog.endDate) / 1000))
            + hmToSec(checkoutDialog.endTime),
        })
        notify('已退房，实收 ' + fmtMoney((Number(updated.total_price) || 0) + (Number(updated.adjust_amount) || 0)))
        checkoutDialog.visible = false
        detailDialog.visible = false
        await loadAll()
        if (activeView.value === 'orders') await loadOrders()
      } catch (e) { /* 拦截器已提示 */ } finally {
        checkoutDialog.saving = false
      }
    }

    async function confirmScheduledCheckout() {
      const o = checkoutDialog.order
      if (!o) return
      checkoutDialog.saving = true
      try {
        const updated = await api.post('/orders/' + o.id + '/checkout', {
          confirm: true,
          total_price: Number(checkoutDialog.amount),
          refund_amount: Number(checkoutDialog.refund) || 0,
          end_timestamp: o.end_timestamp,
        })
        notify('已按预定时间退房，实收 ' + fmtMoney((Number(updated.total_price) || 0) + (Number(updated.adjust_amount) || 0)))
        checkoutDialog.visible = false
        detailDialog.visible = false
        await loadAll()
        if (activeView.value === 'orders') await loadOrders()
      } catch (e) { /* 拦截器已提示 */ } finally {
        checkoutDialog.saving = false
      }
    }

    function onStripClick(seg, day, evt, dayCells) {
      // 日结订单：按点击位置所在盒子（每晚分区）选中对应收款日期
      if (seg.settle_mode === 'daily' && seg.order_type !== 'hourly') {
        let ts = day.ts
        if (dayCells && dayCells.length && evt && evt.currentTarget) {
          const rect = evt.currentTarget.getBoundingClientRect()
          const ratio = (evt.clientX - rect.left) / Math.max(1, rect.width) * 100
          let acc = 0
          for (const dc of dayCells) {
            acc += dc.width
            if (ratio <= acc) { ts = dc.ts; break }
          }
        }
        openDetailById(seg.order_id, ts)
      } else {
        openDetailById(seg.order_id)
      }
    }
    const detailPayDays = computed(() => {
      const o = detailDialog.order
      if (!o || o.order_type !== 'long_term') return []
      const list = []
      let t = dayStart(o.start_timestamp)
      const end = dayStart(o.end_timestamp)
      // 只有过夜日才收款；退房日（不过夜）并入前一天
      while (t < end) {
        const rec = detailDialog.payments.find((x) => x.pay_date === t && x.amount > 0)
        list.push({ ts: t, date: fmtDate(t), paid: !!rec, amount: rec ? rec.amount : 0 })
        t += 86400
      }
      return list
    })
    const detailPayPaid = computed(() => {
      const o = detailDialog.order
      if (!o) return false
      return !!detailDialog.payments.find((x) => x.pay_date === detailPayDay.value && x.amount > 0)
    })
    function selectDetailPayDay(d) {
      detailPayDay.value = d.ts
      detailPayAmount.value = d.paid ? d.amount : (Number(detailDialog.order.daily_price) || Number(detailDialog.order.base_price) || 0)
    }

    // 手机端：在房态页面整体左右滑动切换日期（左滑后一天，右滑前一天）
    const mobileTouch = { x: 0, y: 0, t: 0 }
    function onRoomsTouchStart(evt) {
      const t = evt.touches ? evt.touches[0] : evt
      mobileTouch.x = t.clientX
      mobileTouch.y = t.clientY
      mobileTouch.t = Date.now()
    }
    function onRoomsTouchEnd(evt) {
      const t = evt.changedTouches ? evt.changedTouches[0] : evt
      const dx = t.clientX - mobileTouch.x
      const dy = t.clientY - mobileTouch.y
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.2
          || Date.now() - mobileTouch.t > 600) return
      const cur = mobileDays.value.findIndex((d) => d.ts === mobileDay.value.ts)
      const target = mobileDays.value[cur + (dx < 0 ? 1 : -1)]
      if (target) mobileDay.value = target
    }

    const extendUnitLabel = computed(() =>
      (extendDialog.order && extendDialog.order.order_type === 'hourly') ? '小时' : '天')
    const extendPrice = computed(() => {
      const o = extendDialog.order
      if (!o) return 0
      const n = Number(extendDialog.count) || 0
      if (o.order_type === 'hourly') {
        const newEnd = o.start_timestamp + ((Number(o.rent_hours) || 0) + n) * 3600
        const oldEnd = o.start_timestamp + (Number(o.rent_hours) || 0) * 3600
        const newTotal = (o.base_price || 0) * hourlyNights(o.start_timestamp, newEnd)
        const oldTotal = (o.base_price || 0) * hourlyNights(o.start_timestamp, oldEnd)
        return Math.round(Math.max(0, newTotal - oldTotal) * 100) / 100
      }
      const rate = Number(o.daily_price) || Number(o.base_price) || 0
      return Math.round(rate * Math.ceil(n) * 100) / 100
    })

    function openExtend() {
      extendDialog.order = detailDialog.order
      extendDialog.count = 1
      extendDialog.amount = extendPrice.value
      extendDialog.amountTouched = false
      extendDialog.visible = true
    }

    // 续住数量变化时，未手动修改金额则自动重算
    watch(() => extendDialog.count, () => {
      if (extendDialog.visible && !extendDialog.amountTouched) {
        extendDialog.amount = extendPrice.value
      }
    })

    async function confirmExtend() {
      const o = extendDialog.order
      extendDialog.saving = true
      try {
        const updated = await api.post('/orders/' + o.id + '/extend',
          { count: Number(extendDialog.count), amount: Number(extendDialog.amount) },
          { params: { confirm: true } })
        notify('续住成功，订单总额 ' + fmtMoney(updated.total_price))
        extendDialog.visible = false
        openDetailByOrder(updated)
        await loadAll()
        if (activeView.value === 'orders') await loadOrders()
      } catch (e) { /* 拦截器已提示 */ } finally {
        extendDialog.saving = false
      }
    }

    function openOrderEdit() {
      const o = detailDialog.order
      if (!o) return
      orderEdit.settled = false
      orderEdit.form = {
        room_id: o.room_id,
        order_type: o.order_type,
        settle_mode: o.settle_mode || 'once',
        guest_name: o.guest_name || '',
        guest_phone: o.guest_phone || '',
        guest_source: o.guest_source || '',
        remark: o.remark || '',
        start_timestamp: (o.start_timestamp || 0) * 1000,
        end_timestamp: (o.end_timestamp || 0) * 1000,
        start_date: (o.start_timestamp || 0) ? dayStart(o.start_timestamp) * 1000 : 0,
        start_hm: (o.start_timestamp || 0)
          ? pad(new Date(o.start_timestamp * 1000).getHours()) + ':' + pad(new Date(o.start_timestamp * 1000).getMinutes())
          : '14:00',
        end_date: (o.end_timestamp || 0) ? dayStart(o.end_timestamp) * 1000 : 0,
        end_hm: (o.end_timestamp || 0)
          ? pad(new Date(o.end_timestamp * 1000).getHours()) + ':' + pad(new Date(o.end_timestamp * 1000).getMinutes())
          : '12:00',
        rent_hours: o.rent_hours || 1,
        total_price: o.total_price || 0,
        priceTouched: false,
        status: o.status,
      }
      orderEdit.enabled = true
    }

    function closeOrderEdit() {
      orderEdit.enabled = false
    }

    async function saveOrderEdit() {
      const f = orderEdit.form
      const cur = detailDialog.order
      // 按编辑界面可见的日期/时间重组时间戳（避免备注等修改把日期带成 1970）
      const combine = (dateMs, hm, fallback) => {
        if (dateMs) {
          const d = new Date(dateMs)
          const hmv = String(hm || '14:00').split(':').map(Number)
          d.setHours(hmv[0] || 14, hmv[1] || 0, 0, 0)
          return Math.floor(d.getTime() / 1000)
        }
        return fallback
      }
      const start = combine(f.start_date, f.start_hm, cur ? cur.start_timestamp : 0)
      const end = (f.order_type === 'hourly') ? null
        : combine(f.end_date, f.end_hm, cur ? cur.end_timestamp : 0)
      const payload = {
        room_id: f.room_id,
        order_type: f.order_type,
        settle_mode: f.settle_mode || 'once',
        guest_name: f.guest_name.trim(),
        guest_phone: f.guest_phone.trim(),
        guest_source: (f.guest_source || '').trim(),
        remark: (f.remark || '').trim(),
        start_timestamp: start,
        total_price: Number(f.total_price),
        status: f.status,
      }
      if (f.order_type === 'full_day' || f.order_type === 'long_term') {
        payload.end_timestamp = end
      } else {
        payload.rent_hours = Number(f.rent_hours)
      }
      orderEdit.saving = true
      try {
        const updated = await api.put('/orders/' + detailDialog.order.id, payload)
        notify('订单已修改')
        orderEdit.enabled = false
        openDetailByOrder(updated)
        await loadAll()
        if (activeView.value === 'orders') await loadOrders()
      } catch (e) { /* 拦截器已提示 */ } finally {
        orderEdit.saving = false
      }
    }

    async function doDelete() {
      const o = detailDialog.order
      if (!(await askConfirm({
        title: '删除订单',
        message: '确定删除订单 ' + (o.order_no || o.id) + ' 吗？删除后不可恢复。',
        confirmText: '删除',
      }))) return
      try {
        await api.delete('/orders/' + o.id, { params: { confirm: true } })
        notify('订单已删除')
        detailDialog.visible = false
        await loadAll()
        if (activeView.value === 'orders') await loadOrders()
      } catch (e) { /* 拦截器已提示 */ }
    }

    async function submitAuth() {
      authError.value = ''
      const u = authForm.username.trim()
      const p = authForm.password
      if (!u || !p) { authError.value = '请输入账号与密码'; return }
      if (authMode.value === 'setup' && p !== authForm.confirm) {
        authError.value = '两次输入的密码不一致'
        return
      }
      authSaving.value = true
      try {
        if (authMode.value === 'setup') {
          await api.post('/auth/setup', { username: u, password: p })
        } else {
          await api.post('/auth/login', { username: u, password: p })
        }
        authMode.value = ''
        await loadAll().catch(() => {})
      } catch (e) {
        authError.value = (e.response && e.response.data && e.response.data.detail) || '操作失败，请重试'
      } finally {
        authSaving.value = false
      }
    }
    onMounted(async () => {
      try {
        const s = await api.get('/auth/status')
        localAccess.value = s.local_access !== false
        if (!s.enabled || s.authenticated) {
          loadAll().catch(() => {})
        } else {
          authMode.value = s.needs_setup ? 'setup' : 'login'
        }
      } catch (e) {
        loadAll().catch(() => {})
      }
    })

    return {
      hotelName, activeView, switchView,
      authMode, authForm, authError, authSaving, submitAuth,
      localAccess,
      displayName, settleModeLabel,
      stats, rooms, days, gridStyle, loading,
      statDateLabel,
      cellSegs, activeSegs, cellClass, renderSegs, spanStyle, stripClass, segBlockLabel, segTooltip,
      sourceColor, sourceOptions, channels, CHANNEL_COLORS,
      onCellClick, openDetailById, shift, goToday, loadAll,
      statusTab, timelineOrders, timelineLoading, tlTicks, tlPct, timelineSegments, tlToday,
      selectedDate, onDayHeadClick, timelineShift,
      fmtMoney, fmtTime, fmtDate, fmtStayTime, fmtStayRange, orderDurationLabel, orderTypeLabel, orderStatusType,
      orderList, orderListLoading, orderFilters, loadOrders, resetOrders,
      orderDialog, availableRooms, availableLoading, noRoom, selectedRoom,
      orderStartSec, orderEndSec, suggestedPrice, roomOptionLabel, onOrderTypeChange, sourceIsDirect, syncSettleByChannel,
      openCreateOrder, resetPrice, saveOrder,
      detailDialog, openDetailByOrder, checkoutDialog, confirmScheduledCheckout,
      segTitle, segKindLabel, segSettleLabel, segRepayLabel, segExpLabel,
      openCheckout, confirmCheckout, doCheckin, doDelete,
      cancelDialog, openCancel, confirmCancel,
      onStripClick, detailPayDays, detailPayPaid, selectDetailPayDay,
      extendDialog, extendUnitLabel, extendPrice, openExtend, confirmExtend,
      orderEdit, orderEditRooms, openOrderEdit, closeOrderEdit, saveOrderEdit, orderEditResetPrice,
      isMobile, mobileDay, mobileStatDateLabel, dayObj, dayStart,
      onRoomsTouchStart, onRoomsTouchEnd,
      mobileDays,
      mobileSegments, activeMobileSegs, mobileSegLabel, openMobileOrder, openMobileDetail,
      dateStrOf, datetimeStrOf, parseLocalDate, parseLocalDateTime,
      roomPickerShow, roomPickerColumns, onRoomPickConfirm,
      guestSourcePicker, guestSourceColumns, onGuestSourcePick,
            dbInfo, backingUp, downloadBackup, qrSrc,
      revenueData, revenueLoading, revenueFilters, revenueYears, revenueRange, loadRevenue,
      expenseDialog, openAddExpense, openEditExpense, saveExpense, removeExpense, onRevenueRowClick,
      entryDetail, openEntryDetail,
      onRevenueTouchStart, onRevenueTouchEnd, revenueShift, revenueBack,
      channelDialog, openAddChannel, openEditChannel, saveChannel, removeChannel, repayRuleLabel,
      quickDate, onQuickDate, alertOpen,
      detailPayDay, detailPayAmount, detailPaySaving, saveDetailPayment,
      roomList, roomListLoading, roomFilters, roomStatusMeta, loadRoomList, toggleRoomActive, toggleRoomRepair, toggleRoomClean,
      roomDialog, openCreateRoom, openEditRoom, saveRoom, removeRoom,
      roomCategoryPicker, roomStatusPicker, roomCategoryColumns, roomStatusColumns,
      onRoomCategoryPick, onRoomStatusPick,
      storePicker, storeColumns, onStorePick, storeName,
      stores, currentStoreId, switchStore, openAddStore, saveStore, removeStore, storeDialog,
      orderStoreFilter, roomStoreFilter,
      roomTemplates, roomCategories, templatePicker, templateColumns, selectedTemplateId,
      onTemplatePick, applyRoomTemplateById, openSaveTemplate, deleteRoomTemplate, cancelRoomTemplate, templateManagerDialog,
      roomBatchDialog, openRoomBatch, batchCreateRooms, roomBatchEditDialog, openBatchEdit, saveBatchEdit,
      batchStorePicker, batchCategoryPicker, onBatchStorePick, onBatchCategoryPick,
      addRoomCategory, removeRoomCategory,
      autoSettings, autoMaster, toggleAutoMaster, toggleAutoSetting, automationLogs, loadAutomationLogs, openAutoLogs,
      rollbackAutomation, setOrderAutomation,
      backupList, loadBackups, fmtDateTime, restoreBackup, deleteBackup, backupDialog, openBackupDialog, backupReason, backupSize,
      alerts, loadAlerts, openAlertOrder, orderStatusCls,
      autoActionPicker, autoActionColumns, onAutoActionPick, autoLogDialog,
    }
  },
  template: `
  <div class="page" v-loading="loading">
    <div v-if="authMode" class="auth-screen">
      <div class="auth-card">
        <div class="auth-brand">{{ hotelName }}</div>
        <template v-if="authMode === 'setup'">
          <p class="auth-tip">首次启用：请设置管理员账号与密码</p>
          <el-input v-model="authForm.username" placeholder="管理员账号" maxlength="32"
                    clearable @keyup.enter="submitAuth" />
          <el-input v-model="authForm.password" type="password" show-password
                    placeholder="密码（8 位以上，含字母与数字）" @keyup.enter="submitAuth" />
          <el-input v-model="authForm.confirm" type="password" show-password
                    placeholder="确认密码" @keyup.enter="submitAuth" />
          <el-button type="primary" style="width: 100%" :loading="authSaving"
                     @click="submitAuth">设置并进入</el-button>
        </template>
        <template v-else>
          <p class="auth-tip">请输入账号密码登录</p>
          <el-input v-model="authForm.username" placeholder="账号" maxlength="32"
                    clearable @keyup.enter="submitAuth" />
          <el-input v-model="authForm.password" type="password" show-password
                    placeholder="密码" @keyup.enter="submitAuth" />
          <el-button type="primary" style="width: 100%" :loading="authSaving"
                     @click="submitAuth">登录</el-button>
        </template>
        <p v-if="authError" class="auth-error">{{ authError }}</p>
      </div>
    </div>
    <!-- 房间管理（PC / 移动端共用） -->
    <template v-if="activeView === 'rooms'">
      <van-nav-bar v-if="isMobile" title="房间管理" left-arrow @click-left="activeView = 'status'">
      </van-nav-bar>
      <header v-else class="topbar">
        <div class="top-left">
          <h1 class="title">房间管理</h1>
        </div>
        <div class="nav">
          <el-button size="small" :type="activeView === 'status' ? 'primary' : 'default'" @click="switchView('status')">房态总览</el-button>
          <el-button size="small" :type="activeView === 'orders' ? 'primary' : 'default'" @click="switchView('orders')">订单列表</el-button>
          <el-button size="small" :type="activeView === 'revenue' ? 'primary' : 'default'" @click="switchView('revenue')">收支明细</el-button>
          <el-button size="small" :type="activeView === 'rooms' ? 'primary' : 'default'" @click="switchView('rooms')">房间管理</el-button>
          <el-button size="small" :type="activeView === 'settings' ? 'primary' : 'default'" @click="switchView('settings')">系统设置</el-button>
        </div>
      </header>
      <div class="filter-bar room-filter-bar">
        <el-radio-group v-model="roomFilters.status" size="small" @change="loadRoomList">
          <el-radio-button value="">全部</el-radio-button>
          <el-radio-button value="空闲">空闲</el-radio-button>
          <el-radio-button value="已预订">已预订</el-radio-button>
          <el-radio-button value="已入住">已入住</el-radio-button>
          <el-radio-button value="维修">维修</el-radio-button>
          <el-radio-button value="需打扫">需打扫</el-radio-button>
        </el-radio-group>
        <div class="room-filter-main">
          <el-radio-group v-model="roomFilters.active" size="small" @change="loadRoomList">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button value="1">启用</el-radio-button>
            <el-radio-button value="0">停用</el-radio-button>
          </el-radio-group>
          <div class="room-filter-store">
            <el-select v-model="roomStoreFilter" style="width: 150px" @change="loadRoomList">
          <el-option value="all" label="全部门店" />
              <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
            <el-input v-if="!isMobile" v-model="roomFilters.keyword" placeholder="房号/房型" clearable
                      style="width: 150px" @keyup.enter="loadRoomList" @clear="loadRoomList" />
            <el-button v-if="!isMobile" type="primary" @click="loadRoomList">查询</el-button>
            <el-button v-if="!isMobile" type="primary" plain @click="openBatchEdit">批量编辑</el-button>
            <el-button type="primary" @click="openCreateRoom()">+ 新增房间</el-button>
          </div>
        </div>
        <div v-if="isMobile" class="m-room-kw-row">
          <el-input v-model="roomFilters.keyword" placeholder="房号/房型" clearable
                    @keyup.enter="loadRoomList" @clear="loadRoomList" />
          <el-button size="small" type="primary" style="flex: 1" @click="loadRoomList">查询</el-button>
        </div>
      </div>

      <div class="panel" v-loading="roomListLoading">
        <el-table v-if="!isMobile" :data="roomList" border stripe>
          <el-table-column label="房号" width="140">
            <template #default="{ row }">
              {{ row.room_number }}<span v-if="!roomStoreFilter" class="room-store-mark">（{{ storeName(row.store_id) }}）</span>
            </template>
          </el-table-column>

          <el-table-column label="品类" min-width="120">
            <template #default="{ row }">{{ row.room_category }}</template>
          </el-table-column>
          <el-table-column label="价格" min-width="180">
            <template #default="{ row }">
              全日 ¥{{ row.base_price }}<br />
              钟点 ¥{{ row.hourly_price ? row.hourly_price + '/时' : '自动' }}
            </template>
          </el-table-column>
          <el-table-column label="备注" min-width="140">
            <template #default="{ row }">{{ row.remark || '-' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="row.status === '维修' ? 'info' : row.status === '空闲' ? 'success' : 'warning'"
                      size="small">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="清洁" width="80" align="center">
            <template #default="{ row }">
              <el-switch v-model="row.need_clean" :active-value="1" :inactive-value="0" size="small"
                         @change="(v) => toggleRoomClean(row, v)" />
            </template>
          </el-table-column>
          <el-table-column label="启用" width="70">
            <template #default="{ row }">
              <el-switch :model-value="!!row.is_active" size="small"
                         @change="(v) => toggleRoomActive(row, v)" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openEditRoom(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="removeRoom(row)">
                {{ row.is_active ? '停用' : '删除' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-else class="m-rooms">
          <div class="m-room-card" v-for="room in roomList" :key="room.id">
            <div class="m-room-head">
              <span class="m-room-no">{{ room.room_number }}<span v-if="!roomStoreFilter" class="room-store-mark">（{{ storeName(room.store_id) }}）</span></span>
              <span class="m-room-name">{{ room.room_category }}</span>
              <span class="m-room-status" :class="roomStatusMeta(room).cls">{{ roomStatusMeta(room).text }}</span>
              <van-tag type="primary" plain>{{ room.room_category }}</van-tag>
            </div>
            <div class="m-room-segs">
              <div class="m-free">全日 ¥{{ room.base_price }} · 钟点 ¥{{ room.hourly_price ? room.hourly_price + '/时' : '自动' }}</div>
              <div v-if="room.remark" class="m-room-remark">{{ room.remark }}</div>
            </div>
            <div class="m-room-actions">
              <span class="m-clean-label" :class="{ 'clean-on': room.need_clean }">{{ room.need_clean ? '需打扫' : '已打扫' }}</span>
              <van-switch v-model="room.need_clean" :active-value="1" :inactive-value="0" size="20px"
                          @update:model-value="(v) => toggleRoomClean(room, v)" />
              <van-button size="small" round type="primary" @click="openEditRoom(room)">编辑</van-button>
              <van-button size="small" round type="danger" @click="removeRoom(room)">
                {{ room.is_active ? '停用' : '删除' }}
              </van-button>
            </div>
          </div>
        </div>
      </div>

      <!-- 房间编辑：PC -->
      <el-dialog v-if="!isMobile" v-model="roomDialog.visible"
                 :title="roomDialog.isEdit ? '编辑房间' : '新增房间'" width="480px">
        <el-form label-width="130px">
          <el-form-item label="房间号">
            <el-input v-model="roomDialog.form.room_number" placeholder="如 301" />
          </el-form-item>
          <el-form-item label="房型">
            <el-select v-model="roomDialog.form.room_category" style="width: 100%">
              <el-option v-for="c in roomCategories" :key="c.id" :label="c.name" :value="c.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="套用模板">
            <span class="price-line">
              <el-select v-model="selectedTemplateId" placeholder="选择模板快速填价" style="flex: 1"
                         @change="(v) => applyRoomTemplateById(v)">
                <el-option :value="null" label="不套用模板" />
                <el-option v-for="t in roomTemplates" :key="t.id"
                           :label="t.name + '（' + t.room_category + ' ¥' + t.base_price + '）'" :value="t.id" />
              </el-select>
              <el-button @click="openSaveTemplate">存为模板</el-button>
              <el-button plain @click="templateManagerDialog.visible = true">模板管理</el-button>
            </span>
          </el-form-item>

          <el-form-item label="所属门店">
            <el-select v-model="roomDialog.form.store_id" style="width: 100%">
              <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="全日价">
            <el-input-number v-model="roomDialog.form.base_price" :min="0" :precision="2" />
          </el-form-item>
          <el-form-item label="钟点价">
            <span class="price-line">
              <el-input-number v-model="roomDialog.form.hourly_price" :min="0" :precision="2"
                               :max="Number(roomDialog.form.base_price) || 0" />
              <span class="price-hint">上限=全日价（自动）</span>
            </span>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="roomDialog.form.remark" placeholder="房间备注（选填）" maxlength="200" />
          </el-form-item>
          <el-form-item v-if="roomDialog.isEdit" label="启用">
            <el-switch v-model="roomDialog.form.is_active" :active-value="1" :inactive-value="0" />
          </el-form-item>
          <el-form-item label="维修">
            <el-switch :model-value="roomDialog.form.status === '维修'"
                        @update:model-value="(v) => roomDialog.form.status = v ? '维修' : '空闲'" />
            <span class="price-hint" style="margin-left: 8px;">开启后该房间不可下单，关闭后按订单自动恢复状态</span>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="roomDialog.visible = false">取消</el-button>
          <el-button v-if="!roomDialog.isEdit" type="primary" plain @click="openRoomBatch">批量新建</el-button>
          <el-button type="primary" :loading="roomDialog.saving" @click="saveRoom">保存</el-button>
        </template>
      </el-dialog>

      <!-- 房间编辑：移动端 -->
      <van-popup v-else v-model:show="roomDialog.visible" position="bottom" round class="m-popup">
        <div class="m-popup-title">{{ roomDialog.isEdit ? '编辑房间' : '新增房间' }}</div>
        <div class="m-form">
          <van-field v-model="roomDialog.form.room_number" label="房间号" placeholder="如 301" />
          <van-field :model-value="roomDialog.form.room_category" readonly clickable label="房型"
                     @click="roomCategoryPicker = true" />
          <van-field :model-value="selectedTemplateId ? ((roomTemplates.find((t) => t.id === selectedTemplateId) || {}).name || '') : ''"
                     readonly clickable label="套用模板" placeholder="选择模板快速填价"
                     @click="templatePicker = true" />
          <van-button block round plain size="small" style="margin: 4px 0" @click="openSaveTemplate">存为模板</van-button>

          <van-field :model-value="storeName(roomDialog.form.store_id)" readonly clickable label="所属门店"
                     @click="storePicker = true" />
          <van-field v-model="roomDialog.form.base_price" label="全日价" type="number" placeholder="价格" />
          <van-field v-model="roomDialog.form.hourly_price" label="钟点价" type="number" placeholder="上限=全日价" />
          <van-field :model-value="roomDialog.form.status" readonly clickable label="状态"
                     @click="roomStatusPicker = true" />
          <van-field v-if="roomDialog.isEdit" label="启用">
            <template #input>
              <van-switch v-model="roomDialog.form.is_active" :active-value="1" :inactive-value="0" />
            </template>
          </van-field>
          <van-field v-if="roomDialog.isEdit" label="维修">
            <template #input>
              <van-switch :model-value="roomDialog.form.status === '维修'"
                          @update:model-value="(v) => roomDialog.form.status = v ? '维修' : '空闲'" />
            </template>
          </van-field>
          <van-field v-model="roomDialog.form.remark" label="备注" placeholder="房间备注（选填）" />
        </div>
        <div class="m-popup-actions">
          <van-button block round plain @click="roomDialog.visible = false">取消</van-button>
          <van-button v-if="!roomDialog.isEdit" block round plain type="primary" @click="openRoomBatch">批量新建</van-button>
          <van-button block round type="primary" :loading="roomDialog.saving" @click="saveRoom">保存</van-button>
        </div>
      </van-popup>
      <!-- 模板管理：PC -->
      <el-dialog v-if="!isMobile" v-model="templateManagerDialog.visible" title="房间模板管理" width="480px">
        <div v-if="roomTemplates.length" class="channel-list">
          <div class="channel-item" v-for="t in roomTemplates" :key="t.id">
            <span class="channel-name">{{ t.name }}（{{ t.room_category }} · 全日 ¥{{ t.base_price }}）</span>
            <span class="channel-actions">
              <el-button link type="primary" size="small"
                         @click="applyRoomTemplateById(t.id); templateManagerDialog.visible = false">套用</el-button>
              <el-button link type="danger" size="small" @click="deleteRoomTemplate(t)">删除</el-button>
            </span>
          </div>
        </div>
        <p v-else class="tip">暂无模板，可在新增房间时保存模板</p>
        <template #footer>
          <el-button @click="templateManagerDialog.visible = false">关闭</el-button>
        </template>
      </el-dialog>
      <van-popup v-else v-model:show="templateManagerDialog.visible" position="bottom" round class="m-popup">
        <div class="m-popup-title">房间模板管理</div>
        <van-cell-group inset>
          <van-cell v-for="t in roomTemplates" :key="t.id"
                    :title="t.name + '（' + t.room_category + ' · 全日 ¥' + t.base_price + '）'"
                    value="删除" is-link @click="deleteRoomTemplate(t)" />
        </van-cell-group>
        <p v-if="!roomTemplates.length" class="tip" style="text-align: center;">暂无模板</p>
        <div class="m-popup-actions">
          <van-button block round plain @click="templateManagerDialog.visible = false">关闭</van-button>
        </div>
      </van-popup>

      <!-- 批量新建房间：PC -->
      <el-dialog v-if="!isMobile" v-model="roomBatchDialog.visible" title="批量新建房间" width="420px">
        <el-form label-width="130px">
          <el-form-item label="楼层起">
            <el-input-number v-model="roomBatchDialog.floor_start" :min="1" :max="99" />
          </el-form-item>
          <el-form-item label="楼层止">
            <el-input-number v-model="roomBatchDialog.floor_end" :min="1" :max="99" />
          </el-form-item>
          <el-form-item label="每层房间数">
            <el-input-number v-model="roomBatchDialog.rooms_per_floor" :min="1" :max="99" />
          </el-form-item>
          <p class="tip">按“楼层号 + 房间号”自动生成房号（如 1 楼 3 间 → 101/102/103），使用当前房型与价格。</p>
        </el-form>
        <template #footer>
          <el-button @click="roomBatchDialog.visible = false">取消</el-button>
          <el-button type="primary" :loading="roomBatchDialog.saving" @click="batchCreateRooms">开始批量新建</el-button>
        </template>
      </el-dialog>

      <!-- 批量新建房间：移动端 -->
      <van-popup v-else v-model:show="roomBatchDialog.visible" position="bottom" round class="m-popup">
        <div class="m-popup-title">批量新建房间</div>
        <div class="m-form">
          <van-field v-model="roomBatchDialog.floor_start" label="楼层起" type="number" />
          <van-field v-model="roomBatchDialog.floor_end" label="楼层止" type="number" />
          <van-field v-model="roomBatchDialog.rooms_per_floor" label="每层房间数" type="number" />
          <p class="tip" style="padding: 4px 16px">按“楼层号 + 房间号”自动生成房号，使用当前房型与价格。</p>
        </div>
        <div class="m-popup-actions">
          <van-button block round plain @click="roomBatchDialog.visible = false">取消</van-button>
          <van-button block round type="primary" :loading="roomBatchDialog.saving" @click="batchCreateRooms">开始批量新建</van-button>
        </div>
      </van-popup>

      <!-- 批量编辑房间：PC -->
      <el-dialog v-if="!isMobile" v-model="roomBatchEditDialog.visible" title="批量编辑房间" width="480px">
        <el-form label-width="130px">
          <el-form-item label="门店筛选">
            <el-select v-model="roomBatchEditDialog.store_id" clearable placeholder="全部门店" style="width: 100%">
              <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="房型筛选">
            <el-select v-model="roomBatchEditDialog.room_category" clearable placeholder="全部房型" style="width: 100%">
              <el-option v-for="c in roomCategories" :key="c.id" :label="c.name" :value="c.name" />
            </el-select>
          </el-form-item>
          <el-form-item label="楼层筛选">
            <el-input-number v-model="roomBatchEditDialog.floor" :min="1" :max="99" placeholder="全部楼层" style="width: 170px" />
          </el-form-item>
          <el-divider content-position="left">价格调整（设为与增减可同时填写）</el-divider>
          <el-form-item label="全日价设为">
            <el-input-number v-model="roomBatchEditDialog.set_base_price" :min="0" :precision="2" placeholder="不修改" style="width: 180px" />
          </el-form-item>
          <el-form-item label="全日价增减">
            <el-input-number v-model="roomBatchEditDialog.delta_base_price" :precision="2" style="width: 180px" />
          </el-form-item>
          <el-form-item label="钟点价设为">
            <el-input-number v-model="roomBatchEditDialog.set_hourly_price" :min="0" :precision="2" placeholder="不修改" style="width: 180px" />
          </el-form-item>
          <el-form-item label="钟点价增减">
            <el-input-number v-model="roomBatchEditDialog.delta_hourly_price" :precision="2" style="width: 180px" />
          </el-form-item>
          <p class="tip">仅作用于启用中的房间；可同时按门店、房型、楼层筛选。</p>
        </el-form>
        <template #footer>
          <el-button @click="roomBatchEditDialog.visible = false">取消</el-button>
          <el-button type="primary" :loading="roomBatchEditDialog.saving" @click="saveBatchEdit">保存</el-button>
        </template>
      </el-dialog>

      <!-- 批量编辑房间：移动端 -->
      <van-popup v-else v-model:show="roomBatchEditDialog.visible" position="bottom" round class="m-popup">
        <div class="m-popup-title">批量编辑房间</div>
        <div class="m-form">
          <van-field :model-value="roomBatchEditDialog.store_id ? storeName(roomBatchEditDialog.store_id) : ''"
                     readonly clickable label="门店筛选" placeholder="全部门店" @click="batchStorePicker = true" />
          <van-field :model-value="roomBatchEditDialog.room_category" readonly clickable label="房型筛选"
                     placeholder="全部房型" @click="batchCategoryPicker = true" />
          <van-field v-model="roomBatchEditDialog.floor" label="楼层筛选" type="number" placeholder="空=全部楼层" />
          <van-field v-model="roomBatchEditDialog.set_base_price" label="全日价设为" type="number" placeholder="空=不修改" />
          <van-field v-model="roomBatchEditDialog.delta_base_price" label="全日价增减" type="number" placeholder="可为负" />
          <van-field v-model="roomBatchEditDialog.set_hourly_price" label="钟点价设为" type="number" placeholder="空=不修改" />
          <van-field v-model="roomBatchEditDialog.delta_hourly_price" label="钟点价增减" type="number" placeholder="可为负" />
          <p class="tip" style="padding: 4px 16px">仅作用于启用中的房间。</p>
        </div>
        <div class="m-popup-actions">
          <van-button block round plain @click="roomBatchEditDialog.visible = false">取消</van-button>
          <van-button block round type="primary" :loading="roomBatchEditDialog.saving" @click="saveBatchEdit">保存</van-button>
        </div>
      </van-popup>

      <van-popup v-model:show="batchStorePicker" position="bottom" round>
        <van-picker :columns="storeColumns" @confirm="onBatchStorePick" @cancel="batchStorePicker = false" />
      </van-popup>
      <van-popup v-model:show="batchCategoryPicker" position="bottom" round>
        <van-picker :columns="roomCategoryColumns" @confirm="onBatchCategoryPick" @cancel="batchCategoryPicker = false" />
      </van-popup>
      <van-popup v-model:show="templatePicker" position="bottom" round>
        <van-picker :columns="templateColumns" @confirm="onTemplatePick" @cancel="templatePicker = false" />
      </van-popup>
      <van-popup v-model:show="roomCategoryPicker" position="bottom" round>
        <van-picker :columns="roomCategoryColumns" @confirm="onRoomCategoryPick"
                    @cancel="roomCategoryPicker = false" />
      </van-popup>
      <van-popup v-model:show="roomStatusPicker" position="bottom" round>
        <van-picker :columns="roomStatusColumns" @confirm="onRoomStatusPick"
                    @cancel="roomStatusPicker = false" />
      </van-popup>
      <van-popup v-model:show="storePicker" position="bottom" round>
        <van-picker :columns="storeColumns" @confirm="onStorePick"
                    @cancel="storePicker = false" />
      </van-popup>
    </template>

    <!-- 系统设置（PC / 移动端共用） -->
    <template v-else-if="activeView === 'settings'">
      <van-nav-bar v-if="isMobile" title="系统设置" left-arrow @click-left="activeView = 'status'" />
      <header v-else class="topbar">
        <div class="top-left">
          <h1 class="title">系统设置</h1>
        </div>
        <div class="nav">
          <el-button size="small" :type="activeView === 'status' ? 'primary' : 'default'" @click="switchView('status')">房态总览</el-button>
          <el-button size="small" :type="activeView === 'orders' ? 'primary' : 'default'" @click="switchView('orders')">订单列表</el-button>
          <el-button size="small" :type="activeView === 'revenue' ? 'primary' : 'default'" @click="switchView('revenue')">收支明细</el-button>
          <el-button size="small" :type="activeView === 'rooms' ? 'primary' : 'default'" @click="switchView('rooms')">房间管理</el-button>
          <el-button size="small" :type="activeView === 'settings' ? 'primary' : 'default'" @click="switchView('settings')">系统设置</el-button>
        </div>
      </header>
      <div class="settings-panel">
        <div class="panel">
          <div class="panel-head"><span class="panel-title">数据概览</span></div>
          <div class="settings-stats">
            <div class="s-stat">
              <div class="s-stat-v">{{ dbInfo.rooms }}</div>
              <div class="s-stat-l">房间数</div>
            </div>
            <div class="s-stat">
              <div class="s-stat-v">{{ dbInfo.orders }}</div>
              <div class="s-stat-l">订单数</div>
            </div>
            <div class="s-stat">
              <div class="s-stat-v">{{ dbInfo.version }}</div>
              <div class="s-stat-l">系统版本</div>
            </div>
          </div>
          <p class="tip" v-if="localAccess">数据库：{{ dbInfo.db_path }}</p>
          <p class="tip" v-if="localAccess">备份目录：{{ dbInfo.backups_dir }}</p>
          <p class="tip">系统作者：ECHO4502</p>
        </div>
        <div class="panel" v-if="localAccess">
          <div class="panel-head"><span class="panel-title">数据备份</span></div>
          <div style="display: flex; gap: 10px; flex-wrap: wrap;">
            <el-button type="primary" :loading="backingUp" @click="downloadBackup">一键备份</el-button>
            <el-button type="primary" plain @click="openBackupDialog">读取备份</el-button>
          </div>
          <p class="tip">一键备份会把 ZIP 压缩包（内含 hotel.db）保存到 data/backups/ 目录；系统每次启动也会自动备份（保留最近 7 份）。</p>
          <p class="tip">备份文件名包含时间与原因；读取备份前会自动保留当前数据。</p>
        </div>
        <div class="panel" v-if="localAccess && !isMobile">
          <div class="panel-head"><span class="panel-title">手机扫码访问</span></div>
          <div class="qr-box">
            <img v-if="qrSrc" :src="qrSrc" alt="手机访问二维码" class="qr-img" />
            <span v-else class="tip">二维码加载中…</span>
          </div>
          <p class="tip">手机连接本店 Wi-Fi，扫码即可打开房态系统</p>
          <p class="tip" v-if="dbInfo.access_url">访问地址：{{ dbInfo.access_url }}</p>
        </div>
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">入住渠道管理</span>
            <el-button size="small" type="primary" @click="openAddChannel">+ 新增渠道</el-button>
          </div>
          <div class="channel-list">
            <div class="channel-item" v-for="c in channels" :key="c.id">
              <span class="channel-swatch" :style="{ background: c.color }"></span>
              <span class="channel-name">{{ c.name }}</span>
              <span class="channel-repay" v-if="c.repay_type">{{ repayRuleLabel(c) }}</span>
              <span class="channel-actions">
                <el-button link type="primary" size="small" @click="openEditChannel(c)">编辑</el-button>
                <el-button link type="danger" size="small" @click="removeChannel(c)">删除</el-button>
              </span>
            </div>
            <p v-if="!channels.length" class="tip">暂无入住渠道，请先新增</p>
          </div>
          <p class="tip">渠道用于下单时选择客人来源，并在房态图中按渠道颜色显示；删除渠道不影响已有订单。</p>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">门店管理</span></div>
          <div class="channel-list">
            <div class="channel-item" v-for="s in stores" :key="s.id">
              <span class="channel-name">{{ s.name }}</span>
              <span class="channel-actions">
                <el-button link type="danger" size="small" @click="removeStore(s)">删除</el-button>
              </span>
            </div>
            <p class="tip">删除门店前需确保该门店下没有房间。</p>
          </div>
        </div>
        <div class="panel">
          <div class="panel-head">
            <span class="panel-title">房型管理</span>
            <el-button size="small" type="primary" @click="addRoomCategory">+ 新增房型</el-button>
          </div>
          <div class="channel-list">
            <div class="channel-item" v-for="c in roomCategories" :key="c.id">
              <span class="channel-name">{{ c.name }}</span>
              <span class="channel-actions">
                <el-button link type="danger" size="small" @click="removeRoomCategory(c)">删除</el-button>
              </span>
            </div>
            <p v-if="!roomCategories.length" class="tip">暂无房型，请先新增</p>
          </div>
          <p class="tip">房型用于房间展示与批量编辑筛选；删除前需确保没有房间正在使用该房型。</p>
        </div>
        <div class="panel">
          <div class="panel-head"><span class="panel-title">订单自动维护</span></div>
          <div class="s-row" style="margin: 8px 0;">
            <span class="s-label">启用</span>
            <el-switch v-model="autoMaster" @change="(v) => toggleAutoMaster(v)" />
          </div>
          <div style="display: flex; flex-direction: column; gap: 10px; margin: 8px 0;">
            <div class="s-row"><span class="s-label">自动入住</span>
              <el-switch v-model="autoSettings.checkin" :disabled="!autoMaster"
                         @change="(v) => toggleAutoSetting('checkin', v)" /></div>
            <div class="s-row"><span class="s-label">自动退房</span>
              <el-switch v-model="autoSettings.checkout" :disabled="!autoMaster"
                         @change="(v) => toggleAutoSetting('checkout', v)" /></div>
            <div class="s-row"><span class="s-label">自动续住</span>
              <el-switch v-model="autoSettings.extend" :disabled="!autoMaster"
                         @change="(v) => toggleAutoSetting('extend', v)" /></div>
          </div>
          <p class="tip">总开关开启时系统每 30 秒检查一次，自动操作会记录日志并支持回滚。</p>
          <div class="settings-btn-row">
            <el-button @click="openAutoLogs">查看自动操作记录</el-button>
            <el-button type="danger" plain @click="rollbackAutomation({})">全局回滚自动操作</el-button>
          </div>
        </div>

        <!-- 读取备份：PC -->
        <el-dialog v-if="!isMobile" v-model="backupDialog.visible" title="读取备份" width="560px">
          <div v-if="backupList.length" class="backup-list">
            <div class="backup-item" v-for="b in backupList" :key="b.path">
              <span class="backup-name">{{ b.name }}</span>
              <span class="backup-time">{{ b.reason || backupReason(b.name) }} · {{ b.time_text || fmtDateTime(b.mtime) }} · {{ backupSize(b.size) }}</span>
              <el-button link type="primary" size="small" @click="restoreBackup(b)">恢复</el-button>
              <el-button link type="danger" size="small" @click="deleteBackup(b)">删除</el-button>
            </div>
          </div>
          <p v-else class="tip">暂无备份文件</p>
          <template #footer>
            <el-button @click="backupDialog.visible = false">关闭</el-button>
          </template>
        </el-dialog>
        <van-popup v-else v-model:show="backupDialog.visible" position="bottom" round class="m-popup"
                   style="max-height: 75vh; overflow-y: auto;">
          <div class="m-popup-title">读取备份</div>
          <van-cell-group inset>
            <van-cell v-for="b in backupList" :key="b.path"
                      :title="b.name"
                      :label="(b.reason || backupReason(b.name)) + ' · ' + (b.time_text || fmtDateTime(b.mtime)) + ' · ' + backupSize(b.size)">
              <template #right-icon>
                <div class="backup-actions">
                  <van-button size="mini" plain type="primary" @click="restoreBackup(b)">恢复</van-button>
                  <van-button size="mini" plain type="danger" @click="deleteBackup(b)" style="margin-left: 6px;">删除</van-button>
                </div>
              </template>
            </van-cell>
          </van-cell-group>
          <p v-if="!backupList.length" class="tip" style="text-align: center;">暂无备份文件</p>
          <div class="m-popup-actions">
            <van-button block round plain @click="backupDialog.visible = false">关闭</van-button>
          </div>
        </van-popup>
      </div>
    </template>

    <!-- 收入查看 -->
    <template v-else-if="activeView === 'revenue'">
      <van-nav-bar v-if="isMobile" title="收支明细" left-arrow @click-left="activeView = 'status'" />
      <header v-else class="topbar">
        <div class="top-left">
          <h1 class="title">收支明细</h1>
        </div>
        <div class="nav">
          <el-button size="small" :type="activeView === 'status' ? 'primary' : 'default'" @click="switchView('status')">房态总览</el-button>
          <el-button size="small" :type="activeView === 'orders' ? 'primary' : 'default'" @click="switchView('orders')">订单列表</el-button>
          <el-button size="small" :type="activeView === 'revenue' ? 'primary' : 'default'" @click="switchView('revenue')">收支明细</el-button>
          <el-button size="small" :type="activeView === 'rooms' ? 'primary' : 'default'" @click="switchView('rooms')">房间管理</el-button>
          <el-button size="small" :type="activeView === 'settings' ? 'primary' : 'default'" @click="switchView('settings')">系统设置</el-button>
        </div>
      </header>
      <div class="revenue-panel" v-loading="revenueLoading"
           @touchstart="onRevenueTouchStart" @touchend="onRevenueTouchEnd">
        <div class="filter-bar">
          <el-select v-model="revenueFilters.store_id" style="width: 150px" @change="loadRevenue">
            <el-option :value="null" label="全部门店" />
            <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
          <el-select v-model="revenueFilters.gran" style="width: 110px" @change="loadRevenue">
            <el-option value="all" label="全部" />
            <el-option value="year" label="年" />
            <el-option value="month" label="月" />
            <el-option value="day" label="日" />
          </el-select>
          <el-select v-model="revenueFilters.filter" style="width: 120px" @change="loadRevenue">
            <el-option value="all" label="全部" />
            <el-option value="income" label="收入" />
            <el-option value="repaid" label="已回款" />
            <el-option value="pending" label="待回款" />
            <el-option value="expense" label="支出" />
          </el-select>
          <el-select v-model="revenueFilters.source" style="width: 110px" @change="loadRevenue">
            <el-option value="all" label="全部平台" />
            <el-option v-for="c in channels" :key="c.id" :label="c.name" :value="c.name" />
          </el-select>
          <el-button v-if="isMobile && revenueFilters.gran !== 'year' && revenueFilters.gran !== 'all'" class="rev-back-btn" plain @click="revenueBack">返回上一级</el-button>
          <div class="rev-date-row">
            <template v-if="revenueFilters.gran === 'year'">
              <el-select v-model="revenueFilters.year" style="width: 120px" @change="loadRevenue">
                <el-option v-for="y in revenueYears" :key="y" :label="y + ' 年'" :value="y" />
              </el-select>
            </template>
            <template v-else-if="revenueFilters.gran === 'month'">
              <el-select v-model="revenueFilters.year" style="width: 120px" @change="loadRevenue">
                <el-option v-for="y in revenueYears" :key="y" :label="y + ' 年'" :value="y" />
              </el-select>
              <el-select v-model="revenueFilters.month" style="width: 110px" @change="loadRevenue">
                <el-option v-for="m in 12" :key="m" :label="m + ' 月'" :value="m" />
              </el-select>
            </template>
            <template v-else-if="revenueFilters.gran === 'day'">
              <el-date-picker v-model="revenueFilters.day" type="date" value-format="x"
                              placeholder="选择日期" style="width: 160px" @change="loadRevenue" />
            </template>
            <template v-else-if="revenueFilters.gran === 'custom' || revenueFilters.gran === 'all'">
              <el-date-picker v-model="revenueFilters.range" type="daterange" value-format="x"
                              range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期"
                              style="width: 280px" @change="loadRevenue" />
            </template>
            <el-input v-if="!isMobile" v-model="revenueFilters.keyword" class="rev-kw"
                      placeholder="客人姓名/手机号/房号/订单号" clearable
                      @keyup.enter="loadRevenue" @clear="loadRevenue" />
            <el-button v-if="!isMobile" class="rev-query-btn" type="primary" @click="loadRevenue">查询</el-button>
          </div>
          <el-button class="rev-add-btn" type="primary" @click="openAddExpense">+ 新增收支</el-button>
          <div v-if="isMobile" class="rev-kw-row">
            <el-input v-model="revenueFilters.keyword" class="rev-kw" placeholder="客人姓名/手机号/房号/订单号"
                      clearable @keyup.enter="loadRevenue" @clear="loadRevenue" />
            <el-button class="rev-query-btn" type="primary" @click="loadRevenue">查询</el-button>
          </div>
          <template v-if="!isMobile">
            <el-button @click="revenueShift(-1)" title="前一时间段">‹</el-button>
            <el-button @click="revenueShift(1)" title="后一时间段">›</el-button>
            <el-button v-if="revenueFilters.gran !== 'year' && revenueFilters.gran !== 'all'" plain @click="revenueBack">返回上一级</el-button>
          </template>
        </div>
        <div class="panel">
          <div class="settings-stats">
            <div class="s-stat">
              <div class="s-stat-v">{{ fmtMoney(revenueData ? revenueData.total_income : 0) }}</div>
              <div class="s-stat-l">总销售额</div>
            </div>
            <div class="s-stat">
              <div class="s-stat-v">{{ fmtMoney(revenueData ? revenueData.repaid_amount : 0) }}</div>
              <div class="s-stat-l">已回款</div>
            </div>
            <div class="s-stat">
              <div class="s-stat-v">{{ fmtMoney(revenueData ? revenueData.pending_amount : 0) }}</div>
              <div class="s-stat-l">待回款</div>
            </div>
            <div class="s-stat" v-if="!isMobile">
              <div class="s-stat-v">{{ revenueData ? revenueData.income_count : 0 }}</div>
              <div class="s-stat-l">收入笔数</div>
            </div>
            <div class="s-stat">
              <div class="s-stat-v">{{ fmtMoney(revenueData ? revenueData.total_expense : 0) }}</div>
              <div class="s-stat-l">总支出</div>
            </div>
            <div class="s-stat">
              <div class="s-stat-v" :class="{ 's-stat-neg': revenueData && revenueData.net < 0 }">
                {{ fmtMoney(revenueData ? revenueData.net : 0) }}
              </div>
              <div class="s-stat-l">净收益</div>
            </div>
          </div>
          <template v-if="!isMobile">
          <el-table :data="revenueData ? revenueData.items : []" border stripe
                    class="rev-table-center"
                    @row-click="onRevenueRowClick">
            <template v-if="revenueFilters.gran === 'year' || revenueFilters.gran === 'month' || revenueFilters.gran === 'custom'">
              <el-table-column prop="period"
                               :label="revenueFilters.gran === 'year' ? '月份' : '日期'" width="180" />
              <el-table-column label="收入" width="220">
                <template #default="{ row }">{{ fmtMoney(row.income) }}</template>
              </el-table-column>
              <el-table-column label="支出" width="220">
                <template #default="{ row }">{{ fmtMoney(row.expense) }}</template>
              </el-table-column>
              <el-table-column label="净收益" width="220">
                <template #default="{ row }">{{ fmtMoney(row.net) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="收入笔数" width="90" />
            </template>
            <template v-else>
              <el-table-column label="时间" width="189">
                <template #default="{ row }">{{ fmtTime(row.checkout_time) }}</template>
              </el-table-column>
              <el-table-column label="摘要" width="250">
                <template #default="{ row }">{{ row.kind === 'expense' ? (row.reason || row.period) : row.period }}</template>
              </el-table-column>
              <el-table-column label="备注" width="360">
                <template #default="{ row }">{{ row.remark || '-' }}</template>
              </el-table-column>
              <el-table-column label="收入" width="120">
                <template #default="{ row }">{{ row.kind === 'income' ? fmtMoney(row.income) : '-' }}</template>
              </el-table-column>
              <el-table-column label="支出" min-width="120">
                <template #default="{ row }">{{ row.kind === 'expense' ? fmtMoney(row.expense) : '-' }}</template>
              </el-table-column>
            </template>
          </el-table>
          </template>
          <template v-else>
            <div class="rev-list">
              <template v-if="revenueFilters.gran === 'day' || revenueFilters.gran === 'all'">
                <div class="rev-day-card" v-for="row in (revenueData ? revenueData.items : [])"
                     :key="row.period + '-' + row.checkout_time" @click="onRevenueRowClick(row)">
                  <div class="rev-day-left">
                    <div class="rev-day-summary">{{ row.kind === 'expense' ? (row.reason || row.period) : row.period }}</div>
                    <div class="rev-day-sub">{{ row.remark || '' }}</div>
                    <div class="rev-day-time">{{ fmtTime(row.checkout_time) }}</div>
                  </div>
                  <div class="rev-day-right" :class="row.kind === 'expense' ? 'is-neg' : 'is-pos'">
                    {{ (row.kind === 'expense' ? '-' : '+')
                       + fmtMoney(row.kind === 'expense' ? row.expense : row.income).replace('¥', '') }}
                  </div>
                </div>
                <div v-if="!revenueData || !revenueData.items.length" class="m-order-empty">暂无记录</div>
              </template>
              <template v-else>
                <div class="rev-period-card" v-for="row in (revenueData ? revenueData.items : [])"
                     :key="row.period" @click="onRevenueRowClick(row)">
                  <div class="rev-period-left">{{ row.period }}</div>
                  <div class="rev-period-right">
                    <div class="rev-period-line"><span>收入</span><b class="rev-pos">{{ fmtMoney(row.income) }}</b></div>
                    <div class="rev-period-line"><span>支出</span><b class="rev-neg">{{ fmtMoney(row.expense) }}</b></div>
                    <div class="rev-period-line"><span>净收入</span>
                      <b :class="row.net < 0 ? 'rev-neg' : 'rev-pos'">{{ fmtMoney(row.net) }}</b>
                    </div>
                  </div>
                </div>
                <div v-if="!revenueData || !revenueData.items.length" class="m-order-empty">暂无记录</div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </template>

    <!-- 移动端 -->
    <template v-else-if="isMobile">
      <!-- 移动端订单管理 -->
      <template v-if="activeView === 'orders'">
        <van-nav-bar title="订单管理" left-arrow @click-left="activeView = 'status'">
          <template #right>
            <span class="m-refresh" @click="loadOrders">刷新</span>
          </template>
        </van-nav-bar>
        <div class="m-orders-filter">
          <el-select v-model="orderFilters.gran" @change="loadOrders">
            <el-option value="all" label="全部" />
            <el-option value="year" label="年" />
            <el-option value="month" label="月" />
            <el-option value="day" label="日" />
          </el-select>
          <el-select v-model="orderFilters.order_type" @change="loadOrders">
            <el-option value="all" label="全部类型" />
            <el-option value="full_day" label="全日租" />
            <el-option value="long_term" label="长租" />
            <el-option value="hourly" label="钟点房" />
          </el-select>
          <el-select v-model="orderFilters.source" style="width: 110px" @change="loadOrders">
            <el-option value="all" label="全部平台" />
            <el-option v-for="c in channels" :key="c.id" :label="c.name" :value="c.name" />
          </el-select>
          <el-input v-model="orderFilters.keyword" placeholder="订单号/客人/手机号" clearable
                    @keyup.enter="loadOrders" />
        </div>
        <div class="m-orders-filter">
          <template v-if="orderFilters.gran === 'year'">
            <el-select v-model="orderFilters.year" @change="loadOrders">
              <el-option v-for="y in revenueYears" :key="y" :label="y + ' 年'" :value="y" />
            </el-select>
          </template>
          <template v-else-if="orderFilters.gran === 'month'">
            <el-select v-model="orderFilters.year" @change="loadOrders">
              <el-option v-for="y in revenueYears" :key="y" :label="y + ' 年'" :value="y" />
            </el-select>
            <el-select v-model="orderFilters.month" @change="loadOrders">
              <el-option v-for="m in 12" :key="m" :label="m + ' 月'" :value="m" />
            </el-select>
          </template>
          <template v-else-if="orderFilters.gran === 'day'">
            <el-date-picker v-model="orderFilters.day" type="date" value-format="x"
                            placeholder="选择日期" @change="loadOrders" />
          </template>
          <template v-else-if="orderFilters.gran === 'custom' || orderFilters.gran === 'all'">
            <el-date-picker v-model="orderFilters.range" type="daterange" value-format="x"
                            range-separator="至" start-placeholder="开始" end-placeholder="结束"
                            @change="loadOrders" />
          </template>
        </div>
        <div class="m-orders-filter">
          <el-button size="small" type="primary" style="flex: 1" @click="loadOrders">查询</el-button>
        </div>
        <div class="m-order-list">
          <div class="m-order-card" v-for="o in orderList" :key="o.id">
            <div class="m-order-head">
              <span class="m-order-no">{{ o.order_no }}</span>
              <span class="m-order-type">{{ orderTypeLabel(o.order_type) }}</span>
              <span class="m-order-status" :class="orderStatusCls(o.status)">{{ o.status }}</span>
            </div>
            <div class="m-order-meta">
              <div class="m-meta-line">
                <span>{{ o.room_number }} · {{ displayName(o.guest_name) }}</span>
                <span v-if="o.remark" class="m-order-remark">{{ o.remark }}</span>
              </div>
              <span>{{ fmtStayRange(o) }}</span>
              <span>
                {{ fmtMoney(o.total_price) }}
                <em v-if="o.refund_amount > 0" class="refund-note">（退费 {{ fmtMoney(o.refund_amount) }}）</em>
              </span>
              <span v-if="o.remark" class="m-order-remark">{{ o.remark }}</span>
            </div>
            <div class="m-order-actions">
              <van-button size="small" round plain type="primary" @click="openDetailByOrder(o)">详情</van-button>
            </div>
          </div>
          <div v-if="!orderList.length" class="m-order-empty">暂无订单</div>
        </div>
      </template>
      <template v-else>
      <van-nav-bar>
        <template #left>
          <span class="m-title">{{ hotelName }}</span>
        </template>
        <template #right>
          <span class="m-nav-item" @click="switchView('orders')">订单</span>
          <span class="m-nav-item" @click="switchView('revenue')">收支</span>
          <span class="m-nav-item" @click="switchView('rooms')">房间</span>
          <span class="m-nav-item" @click="switchView('settings')">设置</span>
        </template>
      </van-nav-bar>

      <div class="m-stats">
        <div class="m-stat">
          <div class="m-stat-v stat-arrive">{{ stats.expected_arrivals }}</div>
          <div class="m-stat-l">{{ mobileStatDateLabel }}应到</div>
        </div>
        <div class="m-stat">
          <div class="m-stat-v stat-checkout">{{ stats.expected_checkouts }}</div>
          <div class="m-stat-l">{{ mobileStatDateLabel }}应退</div>
        </div>
        <div class="m-stat">
          <div class="m-stat-v stat-income">{{ fmtMoney(stats.today_revenue) }}</div>
          <div class="m-stat-l">{{ mobileStatDateLabel }}收入</div>
        </div>
        <div class="m-stat">
          <div class="m-stat-v stat-income">{{ fmtMoney(stats.today_repay) }}</div>
          <div class="m-stat-l">今日回款</div>
        </div>
        <div class="m-stat">
          <div class="m-stat-v stat-income">{{ fmtMoney(stats.pending_repay) }}</div>
          <div class="m-stat-l">待回款</div>
        </div>
      </div>

      <div class="m-daybar">
        <van-button size="small" round plain type="primary"
                    @click="mobileDay = dayObj(dayStart(Date.now() / 1000))">今天</van-button>
        <span class="m-day-label">{{ mobileDay.date }}</span>
        <van-button size="small" round type="primary"
                    @click="openCreateOrder(null, mobileDay)">新建订单</van-button>
        <span class="m-refresh" @click="loadAll">刷新</span>
      </div>

      <van-swipe class="m-swipe" :loop="false" :width="72" :initial-swipe="30"
                 :show-indicators="false">
        <van-swipe-item v-for="d in mobileDays" :key="d.date">
          <div class="m-day" :class="{ 'is-active': d.date === mobileDay.date }" @click="mobileDay = d">
            <div class="m-day-w">{{ d.week }}</div>
            <div class="m-day-d">{{ d.monthDay }}</div>
            <div class="m-day-tag" v-if="d.isToday">今</div>
          </div>
        </van-swipe-item>
      </van-swipe>

      <div class="m-rooms" @touchstart="onRoomsTouchStart" @touchend="onRoomsTouchEnd">
        <div class="m-room-card" v-for="room in rooms" :key="room.id">
          <div class="m-room-head">
            <span class="m-room-no">{{ room.room_number }}</span>
            <span class="m-room-name">{{ room.room_name }}</span>
            <van-tag type="primary" plain>{{ room.room_category }}</van-tag>
            <span v-if="room.need_clean" class="clean-mark">需打扫</span>
          </div>
          <div class="m-room-segs">
            <div v-for="seg in mobileSegments(room)" :key="seg.order_no + '-' + seg.start"
                 class="m-seg" :class="{ 'm-seg-out': seg.status === '已退房', 'm-seg-auto': seg.auto === 1 || seg.auto === true }"
                 :style="{ background: seg.status === '已退房' ? '#C0C4CC' : sourceColor(seg.guest_source), color: '#fff' }">
              {{ mobileSegLabel(seg) }}
            </div>
            <div v-if="!activeMobileSegs(room).length" class="m-free">空闲可预订</div>
          </div>
          <div class="m-room-actions">
            <van-button v-if="!activeMobileSegs(room).length" size="small" round type="primary"
                        @click="openMobileOrder(room)">预订</van-button>
            <van-button v-else size="small" round type="warning"
                        @click="openMobileDetail(room)">详情</van-button>
          </div>
        </div>
      </div>

      <!-- 门店分页（房态总览下方） -->
      <div class="store-bar">
        <span class="store-label">门店</span>
        <div class="store-tabs">
          <div v-for="s in stores" :key="s.id" class="store-tab"
               :class="{ 'is-active': s.id === currentStoreId }" @click="switchStore(s.id)">
            {{ s.name }}
          </div>
          <el-button size="small" type="primary" @click="openAddStore">+ 新增门店</el-button>
        </div>
      </div>

      <!-- 移动端：新建订单 Popup -->
      </template>
      <van-popup v-model:show="orderDialog.visible" position="bottom" round class="m-popup">
        <div class="m-popup-title">新建订单</div>
        <div class="m-form">
          <div class="m-form-row">
            <span class="m-label">计费方式</span>
            <van-radio-group v-model="orderDialog.form.order_type" direction="horizontal"
                             @change="onOrderTypeChange">
              <van-radio name="full_day">全日租</van-radio>
              <van-radio name="hourly">钟点房</van-radio>
              <van-radio name="long_term">长租</van-radio>
            </van-radio-group>
          </div>
          <template v-if="orderDialog.form.order_type === 'full_day' || orderDialog.form.order_type === 'long_term'">
            <div class="m-form-row">
              <span class="m-label">入住日期</span>
              <input type="date" class="m-input" :value="dateStrOf(orderDialog.form.checkin_date)"
                     @change="orderDialog.form.checkin_date = parseLocalDate($event.target.value)" />
            </div>
            <div class="m-form-row">
              <span class="m-label">入住时间</span>
              <input type="time" class="m-input" v-model="orderDialog.form.checkin_hm" />
            </div>
            <div class="m-form-row">
              <span class="m-label">离店日期</span>
              <input type="date" class="m-input" :value="dateStrOf(orderDialog.form.checkout_date)"
                     @change="orderDialog.form.checkout_date = parseLocalDate($event.target.value)" />
            </div>
            <div class="m-form-row">
              <span class="m-label">离店时间</span>
              <input type="time" class="m-input" v-model="orderDialog.form.checkout_hm" />
            </div>
            <div class="m-form-row">
              <span class="m-label">每日单价</span>
              <input type="number" class="m-input" v-model.number="orderDialog.form.daily_price" step="0.01"
                     @change="onDailyPriceChange" />
            </div>
          </template>
          <template v-else>
            <div class="m-form-row">
              <span class="m-label">入住日期</span>
              <input type="date" class="m-input" :value="dateStrOf(orderDialog.form.checkin_date)"
                     @change="orderDialog.form.checkin_date = parseLocalDate($event.target.value)" />
            </div>
            <div class="m-form-row">
              <span class="m-label">入住时间</span>
              <input type="time" class="m-input" v-model="orderDialog.form.checkin_hm" />
            </div>
            <div class="m-form-row">
              <span class="m-label">小时数</span>
              <van-stepper v-model="orderDialog.form.rent_hours" :min="0.5" :step="0.5" />
            </div>
          </template>
          <div class="m-form-row">
            <span class="m-label">结算方式</span>
            <van-radio-group v-model="orderDialog.form.settle_mode" direction="horizontal">
              <template v-if="orderDialog.form.order_type === 'long_term'">
                <van-radio name="once">一次性</van-radio>
                <van-radio name="daily">日结</van-radio>
                <van-radio name="ondeparture">退房结算</van-radio>
              </template>
              <template v-else>
                <van-radio name="once" :disabled="!sourceIsDirect(orderDialog.form.guest_source)">入住前实收</van-radio>
                <van-radio name="ondeparture">退房结算</van-radio>
              </template>
            </van-radio-group>
          </div>
          <van-field :model-value="selectedRoom ? selectedRoom.room_number + '（' + selectedRoom.room_category + '）' : ''"
                     readonly clickable label="房间" :placeholder="availableRooms.length ? '选择可用房间' : '该时段暂无空房'"
                     @click="availableRooms.length && (roomPickerShow = true)" />
          <van-field v-model="orderDialog.form.guest_name" label="客人姓名" placeholder="选填，默认散客" />
          <van-field v-model="orderDialog.form.guest_phone" label="手机号" type="tel" maxlength="20" placeholder="选填" />
          <van-field :model-value="orderDialog.form.guest_source || sourceOptions[0] || ''" readonly clickable label="客人来源"
                     @click="guestSourcePicker = true" />
          <van-field v-model="orderDialog.form.price" label="房价" type="number"
                     placeholder="自动计算" @update:model-value="orderDialog.form.priceTouched = true" />
          <van-field v-model="orderDialog.form.remark" label="备注" type="textarea" rows="2" maxlength="200" placeholder="选填" />
        </div>
        <div class="m-popup-actions">
          <van-button block round plain @click="orderDialog.visible = false">取消</van-button>
          <van-button block round type="primary" :disabled="!availableRooms.length"
                      :loading="orderDialog.saving" @click="saveOrder">提交</van-button>
        </div>
      </van-popup>

      <!-- 移动端：房间选择器 -->
      <van-popup v-model:show="roomPickerShow" position="bottom" round>
        <van-picker :columns="roomPickerColumns"
                    @confirm="onRoomPickConfirm" @cancel="roomPickerShow = false" />
      </van-popup>
      <!-- 移动端：客人来源选择器 -->
      <van-popup v-model:show="guestSourcePicker" position="bottom" round>
        <van-picker :columns="guestSourceColumns" @confirm="onGuestSourcePick"
                    @cancel="guestSourcePicker = false" />
      </van-popup>

    </template>

    <!-- PC 端 -->
    <template v-else>
    <header class="topbar">
      <div class="top-left">
        <h1 class="title">{{ hotelName }}</h1>
      </div>
      <div class="nav">
        <el-button size="small" :type="activeView === 'status' ? 'primary' : 'default'"
                   @click="switchView('status')">房态总览</el-button>
        <el-button size="small" :type="activeView === 'orders' ? 'primary' : 'default'"
                   @click="switchView('orders')">订单列表</el-button>
        <el-button size="small" :type="activeView === 'revenue' ? 'primary' : 'default'"
                   @click="switchView('revenue')">收支明细</el-button>
        <el-button size="small" :type="activeView === 'rooms' ? 'primary' : 'default'"
                   @click="switchView('rooms')">房间管理</el-button>
        <el-button size="small" :type="activeView === 'settings' ? 'primary' : 'default'"
                   @click="switchView('settings')">系统设置</el-button>
      </div>
    </header>

    <!-- 房态总览 -->
    <template v-if="activeView === 'status'">
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value stat-arrive">{{ stats.expected_arrivals }}</div>
          <div class="stat-label">{{ statDateLabel }}应到</div>
        </div>
        <div class="stat-card">
          <div class="stat-value stat-checkout">{{ stats.expected_checkouts }}</div>
          <div class="stat-label">{{ statDateLabel }}应退</div>
        </div>
        <div class="stat-card">
          <div class="stat-value stat-income">{{ fmtMoney(stats.today_revenue) }}</div>
          <div class="stat-label">{{ statDateLabel }}收入</div>
        </div>
        <div class="stat-card">
          <div class="stat-value stat-income">{{ fmtMoney(stats.today_repay) }}</div>
          <div class="stat-label">今日回款</div>
        </div>
        <div class="stat-card">
          <div class="stat-value stat-income">{{ fmtMoney(stats.pending_repay) }}</div>
          <div class="stat-label">待回款</div>
        </div>
        <div class="alert-card" v-if="!isMobile && alerts.length">
          <div class="alert-head" @click="alertOpen = !alertOpen">
            <span class="panel-title">待处理提醒（{{ alerts.length }}）</span>
            <span class="alert-toggle">{{ alertOpen ? '收起 ▲' : '展开 ▼' }}</span>
          </div>
          <div class="alert-body" v-show="alertOpen">
            <div class="alert-item" v-for="a in alerts" :key="a.order_id + a.type" @click="openAlertOrder(a.order_id)">
              <span class="alert-dot"></span>{{ a.message }}
            </div>
          </div>
        </div>
      </div>

      <div class="status-tabs">
        <el-radio-group v-model="statusTab" size="small">
          <el-radio-button value="grid">房态网格</el-radio-button>
          <el-radio-button value="timeline">时间轴</el-radio-button>
        </el-radio-group>
      </div>

      <template v-if="statusTab === 'grid'">
        <div class="date-nav">
        <div class="date-buttons">
          <el-button size="small" @click="shift(-7)">前 7 天</el-button>
          <el-button size="small" @click="shift(-1)">‹</el-button>
          <el-button size="small" type="primary" @click="goToday">今天</el-button>
          <el-button size="small" @click="shift(1)">›</el-button>
          <el-button size="small" @click="shift(7)">后 7 天</el-button>
          <span class="range-label" v-if="days.length">
            {{ fmtDate(days[0].ts) }} ~ {{ fmtDate(days[days.length - 1].ts) }}
          </span>
          <el-date-picker v-model="quickDate" type="date" value-format="x" size="small"
                          placeholder="快速选日期" style="width: 140px" @change="onQuickDate" />
        </div>
        <div class="date-actions">
          <el-button size="small" type="primary"
                     @click="openCreateOrder(null, dayObj(dayStart(Date.now() / 1000)))">新建订单</el-button>
          <el-button size="small" @click="loadAll">刷新</el-button>
        </div>
        </div>

        <div class="grid-wrap">
          <div class="grid" :style="gridStyle">
          <div class="grid-head grid-room-head">房间</div>
          <div class="grid-head grid-day-head" v-for="d in days" :key="d.date"
               :class="{ 'is-today': d.isToday, 'is-selected': d.ts === selectedDate }"
               @click="onDayHeadClick(d)" title="点击设为时间轴日期">
            <div class="day-md">{{ d.monthDay }}</div>
            <div class="day-week">{{ d.week }}</div>
            <div class="day-tag" v-if="d.isToday">今天</div>
          </div>

          <template v-for="room in rooms" :key="room.id">
            <div class="grid-room">
              <span class="room-no">{{ room.room_number }}</span>
              <span v-if="room.need_clean" class="clean-mark" title="需打扫">需打扫</span>
              <span class="room-name">{{ room.room_category }}</span>
            </div>
            <div class="grid-cell" v-for="d in days" :key="d.date"
                 :class="cellClass(room, d)"
                 @click="onCellClick(room, d)">
              <div class="cell-strip">
                <el-tooltip v-for="r in renderSegs(room, d)" :key="'s' + r.seg.order_id"
                            :content="segTooltip(r.seg)" placement="top">
                  <div class="strip-seg" :class="stripClass(r.seg)" :style="spanStyle(r)"
                       @click.stop="onStripClick(r.seg, d, $event, r.dayCells)">
                    <template v-if="r.dayCells && r.dayCells.length">
                      <div v-for="(dc, i) in r.dayCells" :key="i" class="seg-day"
                           :class="{ 'pay-unpaid': !dc.paid && !dc.isCheckoutDay, 'is-first': i === 0 }"
                           :style="{ left: dc.left + '%', width: dc.width + '%' }"></div>
                    </template>
                    <span class="strip-label">{{ segBlockLabel(r.seg, d) }}</span>
                  </div>
                </el-tooltip>
                <span v-if="!cellSegs(room, d).length && cellClass(room, d) === 'st-maintenance'" class="cell-label">维修</span>
              </div>
            </div>
          </template>
          </div>
        </div>

      <div class="legend">
        <span class="legend-item"><i class="legend-dot" style="background:#F0F9EB"></i>空闲</span>
        <span class="legend-item" v-for="c in channels" :key="c.id">
          <i class="legend-dot" :style="{ background: c.color }"></i>{{ c.name }}
        </span>
        <span class="legend-item"><i class="legend-dot legend-stripe-gray"></i>已退房</span>
        <span class="legend-item"><i class="legend-dot" style="background:#C0C4CC"></i>维修</span>
      </div>
      </template>

      <!-- 时间轴（24 小时） -->
      <template v-else>
        <div class="tl-nav">
          <el-button size="small" @click="timelineShift(-1)">前一天</el-button>
          <span class="tl-date-hint">时间轴日期：{{ fmtDate(selectedDate) }}（点击房态网格表头日期可切换）</span>
          <el-button size="small" @click="timelineShift(1)">后一天</el-button>
        </div>
        <div class="timeline-panel" v-loading="timelineLoading">
          <div class="tl-head">
            <div class="tl-room-col">房间</div>
            <div class="tl-axis">
              <span class="tl-tick" v-for="h in tlTicks" :key="h"
                    :style="{ left: tlPct(h * 3600) }">{{ h }}:00</span>
            </div>
          </div>
          <div class="tl-row" v-for="room in rooms" :key="room.id">
            <div class="tl-room">
              <span class="room-no">{{ room.room_number }}</span>
              <span>{{ room.room_category }}</span>
            </div>
            <div class="tl-track">
              <span class="tl-gridline" v-for="h in tlTicks" :key="h"
                    :style="{ left: tlPct(h * 3600) }"></span>
              <el-tooltip v-for="seg in timelineSegments(room.id)"
                          :key="seg.order.order_no + '-' + seg.start"
                          :content="'客人：' + displayName(seg.order.guest_name) + ' ｜ 电话：' + (seg.order.guest_phone || '-') + ' ｜ 类型：' + orderTypeLabel(seg.order.order_type) + ' ｜ 来源：' + (seg.order.guest_source || '-')"
                          placement="top">
                <div class="tl-bar"
                     :class="[(seg.order.order_type === 'full_day' || seg.order.order_type === 'long_term') ? 'tl-full' : 'tl-hourly', { 'tl-out': seg.order.status === '已退房' }]"
                     :style="{ left: tlPct(seg.start - tlToday), width: tlPct(seg.end - seg.start), background: seg.order.status === '已退房' ? '#C0C4CC' : sourceColor(seg.order.guest_source) }"
                     @click.stop="openDetailByOrder(seg.order, seg.start)">
                  <span class="tl-bar-label">{{ displayName(seg.order.guest_name) }}</span>
                </div>
              </el-tooltip>
            </div>
          </div>
        </div>
      </template>

      <!-- 门店分页（房态总览下方） -->
      <div class="store-bar">
        <span class="store-label">门店</span>
        <div class="store-tabs">
          <div v-for="s in stores" :key="s.id" class="store-tab"
               :class="{ 'is-active': s.id === currentStoreId }" @click="switchStore(s.id)">
            {{ s.name }}
          </div>
          <el-button size="small" type="primary" @click="openAddStore">+ 新增门店</el-button>
        </div>
      </div>
    </template>

    <!-- 订单列表 -->
    <template v-else>
      <div class="filter-bar">
        <el-select v-model="orderStoreFilter" style="width: 150px" @change="loadOrders">
          <el-option value="all" label="全部门店" />
          <el-option v-for="s in stores" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
        <el-select v-model="orderFilters.order_type" style="width: 120px" @change="loadOrders">
            <el-option value="all" label="全部类型" />
          <el-option value="full_day" label="全日租" />
          <el-option value="long_term" label="长租" />
          <el-option value="hourly" label="钟点房" />
        </el-select>
          <el-select v-model="orderFilters.source" style="width: 110px" @change="loadOrders">
            <el-option value="all" label="全部平台" />
            <el-option v-for="c in channels" :key="c.id" :label="c.name" :value="c.name" />
          </el-select>
        <el-select v-model="orderFilters.gran" style="width: 110px" @change="loadOrders">
          <el-option value="all" label="全部" />
          <el-option value="year" label="年" />
          <el-option value="month" label="月" />
          <el-option value="day" label="日" />
        </el-select>
        <template v-if="orderFilters.gran === 'year'">
          <el-select v-model="orderFilters.year" style="width: 120px" @change="loadOrders">
            <el-option v-for="y in revenueYears" :key="y" :label="y + ' 年'" :value="y" />
          </el-select>
        </template>
        <template v-else-if="orderFilters.gran === 'month'">
          <el-select v-model="orderFilters.year" style="width: 120px" @change="loadOrders">
            <el-option v-for="y in revenueYears" :key="y" :label="y + ' 年'" :value="y" />
          </el-select>
          <el-select v-model="orderFilters.month" style="width: 110px" @change="loadOrders">
            <el-option v-for="m in 12" :key="m" :label="m + ' 月'" :value="m" />
          </el-select>
        </template>
        <template v-else-if="orderFilters.gran === 'day'">
          <el-date-picker v-model="orderFilters.day" type="date" value-format="x"
                          placeholder="选择日期" style="width: 160px" @change="loadOrders" />
        </template>
        <template v-else-if="orderFilters.gran === 'custom' || orderFilters.gran === 'all'">
          <el-date-picker v-model="orderFilters.range" type="daterange" value-format="x"
                          range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期"
                          style="width: 260px" @change="loadOrders" />
        </template>
        <el-input v-model="orderFilters.room_number" placeholder="房间号" clearable style="width: 140px"
                        @keyup.enter="loadOrders" />
        <el-input v-model="orderFilters.keyword" placeholder="订单号/客人姓名/手机号" clearable style="width: 180px"
                        @keyup.enter="loadOrders" />
        <el-button type="primary" @click="loadOrders">查询</el-button>
        <el-button @click="resetOrders">重置</el-button>
      </div>

      <el-table :data="orderList" border stripe v-loading="orderListLoading"
                class="order-table" @row-click="(row) => openDetailByOrder(row)">
        <el-table-column prop="order_no" label="订单号" width="150" />
        <el-table-column prop="room_number" label="房间" width="80" />
        <el-table-column label="类型" width="80">
          <template #default="{ row }">{{ orderTypeLabel(row.order_type) }}</template>
        </el-table-column>
        <el-table-column prop="guest_name" label="客人" width="110" />
        <el-table-column label="入住-离店" min-width="130">
          <template #default="{ row }">
            {{ fmtStayRange(row) }}
          </template>
        </el-table-column>
        <el-table-column label="备注" min-width="130" show-overflow-tooltip>
          <template #default="{ row }">{{ row.remark || '-' }}</template>
        </el-table-column>
        <el-table-column label="总价" width="200">
          <template #default="{ row }">
            {{ fmtMoney(row.total_price) }}
            <span v-if="row.adjust_amount > 0.001" class="refund-note">（多收 {{ fmtMoney(row.adjust_amount) }}）</span>
            <span v-else-if="row.adjust_amount < -0.001" class="refund-note">（少收 {{ fmtMoney(-row.adjust_amount) }}）</span>
            <span v-if="row.refund_amount > 0" class="refund-note">（退费 {{ fmtMoney(row.refund_amount) }}）</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="orderStatusType(row.status)" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click.stop="openDetailByOrder(row)">详情</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <!-- 新建订单 -->
    <el-dialog v-model="orderDialog.visible" title="新建订单" width="640px">
      <el-form label-width="100px">
        <el-form-item label="计费方式">
          <el-select v-model="orderDialog.form.order_type" style="width: 100%" @change="onOrderTypeChange">
            <el-option value="full_day" label="全日租" />
            <el-option value="hourly" label="钟点房" />
            <el-option value="long_term" label="长租" />
          </el-select>
        </el-form-item>
        <template v-if="orderDialog.form.order_type === 'full_day' || orderDialog.form.order_type === 'long_term'">
          <el-form-item label="入住日期">
            <el-date-picker v-model="orderDialog.form.checkin_date" type="date"
                            placeholder="入住日期" value-format="x" style="width: 100%" />
          </el-form-item>
          <el-form-item label="入住时间">
            <el-time-picker v-model="orderDialog.form.checkin_hm" format="HH:mm" value-format="HH:mm"
                            style="width: 100%" />
          </el-form-item>
          <el-form-item label="离店日期">
            <el-date-picker v-model="orderDialog.form.checkout_date" type="date"
                            placeholder="离店日期" value-format="x" style="width: 100%" />
          </el-form-item>
          <el-form-item label="离店时间">
            <el-time-picker v-model="orderDialog.form.checkout_hm" format="HH:mm" value-format="HH:mm"
                            style="width: 100%" />
          </el-form-item>
          <el-form-item label="每日单价">
            <el-input-number v-model="orderDialog.form.daily_price" :min="0" :precision="2" @change="onDailyPriceChange" />
            <span class="form-hint">自动按 单价 × 天数 计算总价</span>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="入住日期">
            <el-date-picker v-model="orderDialog.form.checkin_date" type="date"
                            placeholder="入住日期" value-format="x" style="width: 100%" />
          </el-form-item>
          <el-form-item label="入住时间">
            <el-time-picker v-model="orderDialog.form.checkin_hm" format="HH:mm" value-format="HH:mm"
                            style="width: 100%" />
          </el-form-item>
          <el-form-item label="入住小时数">
            <el-input-number v-model="orderDialog.form.rent_hours" :min="0.5" :step="0.5" />
            <span class="form-hint">结束时间：{{ orderEndSec() ? fmtTime(orderEndSec()) : '-' }}</span>
          </el-form-item>
        </template>
        <el-form-item label="结算方式">
          <el-select v-model="orderDialog.form.settle_mode" style="width: 100%">
            <template v-if="orderDialog.form.order_type === 'long_term'">
              <el-option value="once" label="一次性先付" />
              <el-option value="daily" label="日结" />
              <el-option value="ondeparture" label="退房结算" />
            </template>
            <template v-else>
              <el-option value="once" label="入住前实收" :disabled="!sourceIsDirect(orderDialog.form.guest_source)" />
              <el-option value="ondeparture" label="退房结算" />
            </template>
          </el-select>
        </el-form-item>
        <el-form-item label="房间号">
          <el-select v-model="orderDialog.form.room_id" filterable placeholder="选择可用房间"
                     :loading="availableLoading" style="width: 100%">
            <el-option v-for="r in availableRooms" :key="r.id"
                       :label="roomOptionLabel(r)"
                       :value="r.id" />
          </el-select>
          <div v-if="noRoom" class="no-room">该时段暂无空房</div>
        </el-form-item>
        <el-form-item label="客人姓名">
          <el-input v-model="orderDialog.form.guest_name" placeholder="选填，默认散客" />
        </el-form-item>
        <el-form-item label="客人手机号">
          <el-input v-model="orderDialog.form.guest_phone" placeholder="选填" maxlength="20" />
        </el-form-item>
        <el-form-item label="客人来源">
          <el-select v-model="orderDialog.form.guest_source" placeholder="选择入住渠道" style="width: 100%"
                     @change="syncSettleByChannel">
            <el-option v-for="s in sourceOptions" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="房价">
          <el-input-number v-model="orderDialog.form.price" :min="0" :precision="2"
                           @change="orderDialog.form.priceTouched = true" />
          <el-button link type="primary" size="small" @click="resetPrice">自动计算</el-button>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="orderDialog.form.remark" type="textarea" :rows="2"
                    maxlength="200" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="orderDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="orderDialog.saving"
                   :disabled="!availableLoading && !availableRooms.length"
                   @click="saveOrder">提交</el-button>
      </template>
    </el-dialog>

    </template>

    <!-- 自动操作记录：PC -->
    <el-dialog v-if="!isMobile" v-model="autoLogDialog.visible" title="自动操作记录" width="640px" class="auto-log-dialog">
      <div v-if="automationLogs.length" class="channel-list">
        <div class="channel-item" v-for="log in automationLogs" :key="log.id">
          <span class="channel-name">{{ log.note }} · {{ log.order_no || ('订单#' + log.order_id) }}
            · {{ log.order_date ? fmtDate(log.order_date) : '' }} · {{ log.room_number || '' }} · {{ log.guest_name || '散客' }}</span>
          <span class="channel-actions">
            <el-button link type="primary" size="small" @click="openAlertOrder(log.order_id)">查看</el-button>
            <el-button link type="danger" size="small"
                       @click="rollbackAutomation({ logId: log.id })">回滚</el-button>
          </span>
        </div>
      </div>
      <p v-else class="tip">暂无自动操作记录</p>
      <template #footer>
        <el-button @click="autoLogDialog.visible = false">关闭</el-button>
      </template>
    </el-dialog>
    <van-popup v-else v-model:show="autoLogDialog.visible" position="bottom" round class="m-popup"
               style="max-height: 75vh; overflow-y: auto;">
      <div class="m-popup-title">自动操作记录</div>
      <van-cell-group inset>
        <van-cell v-for="log in automationLogs" :key="log.id"
                  :title="log.note + ' · ' + (log.order_no || ('订单#' + log.order_id))"
                  :label="(log.order_date ? fmtDate(log.order_date) + ' · ' : '') + (log.room_number || '') + ' · ' + (log.guest_name || '散客')">
          <template #value>
            <span class="s-label link" @click.stop="openAlertOrder(log.order_id)">查看</span>
            <span class="s-label link danger" @click.stop="rollbackAutomation({ logId: log.id })">回滚</span>
          </template>
        </van-cell>
      </van-cell-group>
      <p v-if="!automationLogs.length" class="tip" style="text-align: center;">暂无自动操作记录</p>
      <div class="m-popup-actions">
        <van-button block round plain @click="autoLogDialog.visible = false">关闭</van-button>
      </div>
    </van-popup>
    <van-popup v-model:show="autoActionPicker" position="bottom" round>
      <van-picker :columns="autoActionColumns" @confirm="onAutoActionPick" @cancel="autoActionPicker = false" />
    </van-popup>
    <!-- 订单详情 -->
    <el-dialog v-if="!isMobile" v-model="detailDialog.visible" title="订单详情" width="680px">
      <template v-if="detailDialog.order && !orderEdit.enabled">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="订单号">{{ detailDialog.order.order_no }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="orderStatusType(detailDialog.order.status)" size="small">{{ detailDialog.order.status }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="房间">{{ detailDialog.order.room_number }}（{{ detailDialog.order.room_category }}）</el-descriptions-item>
          <el-descriptions-item label="计费方式">{{ orderTypeLabel(detailDialog.order.order_type) }}</el-descriptions-item>
          <el-descriptions-item label="结算方式">
            {{ settleModeLabel(detailDialog.order.settle_mode) }}
          </el-descriptions-item>

          <el-descriptions-item label="客人">{{ detailDialog.order.guest_name }}</el-descriptions-item>
          <el-descriptions-item label="手机号">{{ detailDialog.order.guest_phone || '-' }}</el-descriptions-item>
          <el-descriptions-item label="客源">{{ detailDialog.order.guest_source || '-' }}</el-descriptions-item>
          <el-descriptions-item label="入住时间">{{ fmtStayTime(detailDialog.order, 'start') }}</el-descriptions-item>
          <el-descriptions-item label="离店时间">{{ fmtStayTime(detailDialog.order, 'end') }}</el-descriptions-item>
          <el-descriptions-item label="总价">
            {{ fmtMoney(detailDialog.order.total_price) }}
            <span v-if="detailDialog.order.adjust_amount > 0.001" class="refund-note">
              （多收 {{ fmtMoney(detailDialog.order.adjust_amount) }}）
            </span>
            <span v-else-if="detailDialog.order.adjust_amount < -0.001" class="refund-note">
              （少收 {{ fmtMoney(-detailDialog.order.adjust_amount) }}）
            </span>
            <span v-if="detailDialog.order.refund_amount > 0" class="refund-note">
              （退费 {{ fmtMoney(detailDialog.order.refund_amount) }}）
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="时长">{{ orderDurationLabel(detailDialog.order) }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="2">{{ detailDialog.order.remark || '-' }}</el-descriptions-item>
        </el-descriptions>
        <div v-if="detailDialog.segments && detailDialog.segments.length" class="seg-block">
          <div class="seg-block-title">{{ segTitle }}</div>
          <div v-for="s in detailDialog.segments" :key="s.id" class="seg-item">
            <span class="seg-kind">{{ segKindLabel(s) }}</span>
            <span class="seg-amt">{{ fmtMoney(s.amount) }}</span>
            <span class="seg-date">{{ segSettleLabel(s) }}</span>
            <span class="seg-status">{{ segRepayLabel(s) }}</span>
            <span v-if="s.expected_repay_date" class="seg-date">{{ segExpLabel(s) }}</span>
            <span v-if="s.remark" class="seg-remark">{{ s.remark }}</span>
          </div>
        </div>
        <div v-if="detailDialog.order && detailDialog.order.order_type === 'long_term' && detailDialog.order.settle_mode === 'daily'" class="detail-pay">
          <div class="panel-title">日结收款</div>
          <div class="pay-summary">
            <span>每日应收：{{ fmtMoney(Number(detailDialog.order.daily_price) || Number(detailDialog.order.base_price) || 0) }}</span>
            <span>收款日期：{{ fmtDate(detailPayDay) }}</span>
            <span :class="detailPayPaid ? 'pay-paid' : 'pay-unpaid'">{{ detailPayPaid ? '已收' : '未收' }}</span>
          </div>
          <div class="pay-add">
            <span class="s-label">实收金额</span>
            <el-input-number v-model="detailPayAmount" :min="0" :precision="2" size="small" />
            <el-button type="success" size="small" :loading="detailPaySaving" @click="saveDetailPayment">
              {{ detailPayPaid ? '更新当日收款' : '标记已收当日款' }}
            </el-button>
          </div>
          <div class="pay-days">
            <div class="pay-day-row" v-for="d in detailPayDays" :key="d.ts"
                 :class="{ 'is-current': d.ts === detailPayDay }"
                 @click="selectDetailPayDay(d)" title="点击切换收款日期">
              <span>{{ d.date }}</span>
              <span>{{ d.paid ? '已收 ' + fmtMoney(d.amount) : '未收' }}</span>
            </div>
          </div>
        </div>
      </template>
      <template v-else-if="detailDialog.order">
        <el-form label-width="100px">
          <el-form-item label="订单号">
            <span>{{ detailDialog.order.order_no }}</span>
          </el-form-item>
          <el-form-item label="房间">
            <el-select v-model="orderEdit.form.room_id" style="width: 100%">
              <el-option v-for="r in orderEditRooms" :key="r.id"
                         :label="r.room_number + '（' + r.room_category + '）'" :value="r.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="计费方式">
            <el-select v-model="orderEdit.form.order_type" style="width: 100%">
              <el-option value="full_day" label="全日租" />
              <el-option value="hourly" label="钟点房" />
              <el-option value="long_term" label="长租" />
            </el-select>
          </el-form-item>
          <el-form-item label="结算方式">
            <el-select v-model="orderEdit.form.settle_mode" style="width: 100%">
              <template v-if="orderEdit.form.order_type === 'long_term'">
                <el-option value="once" label="一次性先付" />
                <el-option value="daily" label="日结" />
                <el-option value="ondeparture" label="退房结算" />
              </template>
              <template v-else>
                <el-option value="once" label="入住前实收" :disabled="!sourceIsDirect(orderEdit.form.guest_source)" />
                <el-option value="ondeparture" label="退房结算" />
              </template>
            </el-select>
          </el-form-item>
          <el-form-item label="客人姓名">
            <el-input v-model="orderEdit.form.guest_name" />
          </el-form-item>
          <el-form-item label="手机号">
            <el-input v-model="orderEdit.form.guest_phone" maxlength="20" />
          </el-form-item>
          <el-form-item label="入住日期">
            <el-date-picker v-model="orderEdit.form.start_date" type="date" value-format="x" style="width: 100%" />
          </el-form-item>
          <el-form-item label="入住时间">
            <el-time-picker v-model="orderEdit.form.start_hm" format="HH:mm" value-format="HH:mm" style="width: 100%" />
          </el-form-item>
          <template v-if="orderEdit.form.order_type === 'full_day' || orderEdit.form.order_type === 'long_term'">
            <el-form-item label="离店日期">
              <el-date-picker v-model="orderEdit.form.end_date" type="date" value-format="x" style="width: 100%" />
            </el-form-item>
            <el-form-item label="离店时间">
              <el-time-picker v-model="orderEdit.form.end_hm" format="HH:mm" value-format="HH:mm" style="width: 100%" />
            </el-form-item>
          </template>
          <template v-else>
            <el-form-item label="钟点时长(时)">
              <el-input-number v-model="orderEdit.form.rent_hours" :min="0.5" :step="0.5" />
            </el-form-item>
          </template>
          <el-form-item label="金额">
            <el-input-number v-model="orderEdit.form.total_price" :min="0" :precision="2"
                             @change="orderEdit.form.priceTouched = true" />
            <el-button link type="primary" size="small" @click="orderEditResetPrice">自动计算</el-button>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="orderEdit.form.status" style="width: 100%">
              <el-option v-for="s in ['已预订','已入住','已退房','已取消']" :key="s" :label="s" :value="s" />
            </el-select>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="orderEdit.form.remark" type="textarea" :rows="2" />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <template v-if="orderEdit.enabled">
          <el-button @click="closeOrderEdit">取消</el-button>
          <el-button type="primary" :loading="orderEdit.saving" @click="saveOrderEdit">保存修改</el-button>
        </template>
        <template v-else>
          <div v-if="detailDialog.order && detailDialog.order.order_type !== 'long_term'" class="detail-auto">
            <span class="s-label">自动入住</span>
            <el-switch :model-value="detailDialog.order.auto_checkin_enabled === 1" size="small"
                       @change="(v) => setOrderAutomation(detailDialog.order, v, detailDialog.order.auto_depart_enabled === 1, detailDialog.order.auto_action)" />
            <span class="s-label" style="margin-left: 8px;">到期自动操作</span>
            <el-switch :model-value="detailDialog.order.auto_depart_enabled === 1" size="small"
                       @change="(v) => setOrderAutomation(detailDialog.order, detailDialog.order.auto_checkin_enabled === 1, v, detailDialog.order.auto_action)" />
            <template v-if="detailDialog.order.auto_depart_enabled === 1">
              <span class="s-label" style="margin-left: 4px;">到期执行</span>
              <el-radio-group :model-value="detailDialog.order.auto_action" size="small"
                              @change="(v) => setOrderAutomation(detailDialog.order, detailDialog.order.auto_checkin_enabled === 1, true, v)">
                <el-radio-button value="checkout">自动退房</el-radio-button>
                <el-radio-button value="extend">自动续住</el-radio-button>
              </el-radio-group>
            </template>
            <el-button link type="danger" size="small"
                       @click="rollbackAutomation({ orderId: detailDialog.order.id })">回滚自动操作</el-button>
          </div>
          <el-button @click="detailDialog.visible = false">关闭</el-button>
          <el-button type="primary" plain @click="openOrderEdit">编辑</el-button>
          <el-button v-if="detailDialog.order && (detailDialog.order.status === '已预订' || detailDialog.order.status === '已入住')"
                     type="primary" plain @click="openExtend">续住</el-button>

          <el-button v-if="detailDialog.order && detailDialog.order.status === '已预订'" type="success" @click="doCheckin">入住</el-button>
          <el-button v-if="detailDialog.order && detailDialog.order.status === '已预订'" type="info" @click="openCancel">取消</el-button>
          <el-button v-if="detailDialog.order && detailDialog.order.status === '已入住'" type="warning" @click="openCheckout">退房</el-button>
          <el-button v-if="detailDialog.order && (detailDialog.order.status === '已退房' || detailDialog.order.status === '已取消')"
                     type="danger" @click="doDelete">删除</el-button>
        </template>
      </template>
    </el-dialog>
      <van-popup v-else v-model:show="detailDialog.visible" position="bottom" round class="m-popup">
        <template v-if="detailDialog.order && !orderEdit.enabled">
          <div class="m-popup-title">订单详情</div>
          <van-cell-group inset>
            <van-cell title="订单号" :value="detailDialog.order.order_no" />
            <van-cell title="房间" :value="detailDialog.order.room_number + '（' + detailDialog.order.room_category + '）'" />
            <van-cell title="计费方式" :value="orderTypeLabel(detailDialog.order.order_type)" />
            <van-cell title="结算方式" :value="settleModeLabel(detailDialog.order.settle_mode)" />

            <van-cell title="客人" :value="detailDialog.order.guest_name" />
            <van-cell title="手机号" :value="detailDialog.order.guest_phone || '-'" />
            <van-cell title="客源" :value="detailDialog.order.guest_source || '-'" />
            <van-cell title="入住时间" :value="fmtStayTime(detailDialog.order, 'start')" />
            <van-cell title="离店时间" :value="fmtStayTime(detailDialog.order, 'end')" />
            <van-cell title="金额"
                      :value="fmtMoney(detailDialog.order.total_price)
                              + (detailDialog.order.adjust_amount > 0.001
                                  ? '（多收 ' + fmtMoney(detailDialog.order.adjust_amount) + '）' : '')
                              + (detailDialog.order.adjust_amount < -0.001
                                  ? '（少收 ' + fmtMoney(-detailDialog.order.adjust_amount) + '）' : '')
                              + (detailDialog.order.refund_amount > 0
                                  ? '（退费 ' + fmtMoney(detailDialog.order.refund_amount) + '）' : '')" />
            <van-cell title="时长" :value="orderDurationLabel(detailDialog.order)" />
            <van-cell title="状态" :value="detailDialog.order.status" />
            <van-cell title="备注" :value="detailDialog.order.remark || '-'" />
          </van-cell-group>
          <div v-if="detailDialog.segments && detailDialog.segments.length" class="seg-block m-seg-block">
            <div class="seg-block-title">{{ segTitle }}</div>
            <div v-for="s in detailDialog.segments" :key="s.id" class="seg-item">
              <span class="seg-kind">{{ segKindLabel(s) }}</span>
              <span class="seg-amt">{{ fmtMoney(s.amount) }}</span>
              <span class="seg-date">{{ segSettleLabel(s) }}</span>
              <span class="seg-status">{{ segRepayLabel(s) }}</span>
              <span v-if="s.expected_repay_date" class="seg-date">{{ segExpLabel(s) }}</span>
              <span v-if="s.remark" class="seg-remark">{{ s.remark }}</span>
            </div>
          </div>
          <div v-if="detailDialog.order && detailDialog.order.order_type === 'long_term' && detailDialog.order.settle_mode === 'daily'" class="detail-pay m-detail-pay">
            <div class="panel-title">日结收款</div>
            <van-cell-group inset>
              <van-cell title="收款日期" :value="fmtDate(detailPayDay)" />
              <van-cell title="每日应收"
                        :value="fmtMoney(Number(detailDialog.order.daily_price) || Number(detailDialog.order.base_price) || 0)" />
              <van-cell :title="detailPayPaid ? '已收' : '未收'">
                <input type="number" class="m-input" v-model.number="detailPayAmount" step="0.01" />
              </van-cell>
            </van-cell-group>
            <div class="pay-days" style="padding: 0 16px;">
              <div class="pay-day-row" v-for="d in detailPayDays" :key="d.ts"
                   :class="{ 'is-current': d.ts === detailPayDay }"
                   @click="selectDetailPayDay(d)">
                <span>{{ d.date }}</span>
                <span>{{ d.paid ? '已收 ' + fmtMoney(d.amount) : '未收' }}</span>
              </div>
            </div>
            <van-button block round type="success" :loading="detailPaySaving"
                        @click="saveDetailPayment" style="margin: 8px 16px;">
              {{ detailPayPaid ? '更新当日收款' : '标记已收当日款' }}
            </van-button>
          </div>
          <div class="m-popup-actions">
            <van-button size="small" round plain @click="detailDialog.visible = false">关闭</van-button>
            <van-button size="small" round plain type="primary" @click="openOrderEdit">编辑</van-button>
            <van-button v-if="detailDialog.order.status === '已预订' || detailDialog.order.status === '已入住'"
                        size="small" round plain type="primary" @click="openExtend">续住</van-button>

            <van-button v-if="detailDialog.order.status === '已预订'" size="small" round type="success" @click="doCheckin">入住</van-button>
            <van-button v-if="detailDialog.order.status === '已预订'" size="small" round type="default" @click="openCancel">取消</van-button>
            <van-button v-if="detailDialog.order.status === '已入住'" size="small" round type="warning" @click="openCheckout">退房</van-button>
            <van-button v-if="detailDialog.order.status === '已退房' || detailDialog.order.status === '已取消'"
                        size="small" round type="danger" @click="doDelete">删除</van-button>
          </div>
          <div v-if="detailDialog.order && detailDialog.order.order_type !== 'long_term'" class="m-detail-auto">
            <span class="s-label">自动入住</span>
            <van-switch :model-value="detailDialog.order.auto_checkin_enabled === 1" size="20px"
                        @update:model-value="(v) => setOrderAutomation(detailDialog.order, v, detailDialog.order.auto_depart_enabled === 1, detailDialog.order.auto_action)" />
            <span class="s-label">到期自动操作</span>
            <van-switch :model-value="detailDialog.order.auto_depart_enabled === 1" size="20px"
                        @update:model-value="(v) => setOrderAutomation(detailDialog.order, detailDialog.order.auto_checkin_enabled === 1, v, detailDialog.order.auto_action)" />
            <div v-if="detailDialog.order.auto_depart_enabled === 1" class="m-auto-line">
              <span class="s-label">到期执行</span>
              <span class="s-label link" @click="autoActionPicker = true">{{ detailDialog.order.auto_action === 'extend' ? '自动续住' : '自动退房' }}</span>
            </div>
            <span class="s-label link danger" @click="rollbackAutomation({ orderId: detailDialog.order.id })">回滚自动操作</span>
          </div>
        </template>
        <template v-else-if="detailDialog.order">
          <div class="m-popup-title">编辑订单</div>
          <div class="m-form">
            <div class="m-form-row">
              <span class="m-label">房间</span>
              <select class="m-input" v-model.number="orderEdit.form.room_id">
                <option v-for="r in orderEditRooms" :key="r.id" :value="r.id">
                  {{ r.room_number }}（{{ r.room_category }}）
                </option>
              </select>
            </div>
            <div class="m-form-row">
              <span class="m-label">计费方式</span>
              <van-radio-group v-model="orderEdit.form.order_type" direction="horizontal">
                <van-radio name="full_day">全日租</van-radio>
                <van-radio name="hourly">钟点房</van-radio>
                <van-radio name="long_term">长租</van-radio>
              </van-radio-group>
            </div>
            <div class="m-form-row">
              <span class="m-label">结算方式</span>
              <van-radio-group v-model="orderEdit.form.settle_mode" direction="horizontal">
                <template v-if="orderEdit.form.order_type === 'long_term'">
                  <van-radio name="once">一次性</van-radio>
                  <van-radio name="daily">日结</van-radio>
                  <van-radio name="ondeparture">退房结算</van-radio>
                </template>
                <template v-else>
                  <van-radio name="once" :disabled="!sourceIsDirect(orderEdit.form.guest_source)">入住前实收</van-radio>
                  <van-radio name="ondeparture">退房结算</van-radio>
                </template>
              </van-radio-group>
            </div>
            <div class="m-form-row">
              <span class="m-label">客人姓名</span>
              <input class="m-input" v-model="orderEdit.form.guest_name" />
            </div>
            <div class="m-form-row">
              <span class="m-label">手机号</span>
              <input class="m-input" v-model="orderEdit.form.guest_phone" type="tel" maxlength="20" />
            </div>
            <div class="m-form-row">
              <span class="m-label">入住日期</span>
              <input type="date" class="m-input" :value="dateStrOf(orderEdit.form.start_date)"
                     @change="orderEdit.form.start_date = parseLocalDate($event.target.value)" />
            </div>
            <div class="m-form-row">
              <span class="m-label">入住时间</span>
              <input type="time" class="m-input" v-model="orderEdit.form.start_hm" />
            </div>
            <template v-if="orderEdit.form.order_type === 'full_day' || orderEdit.form.order_type === 'long_term'">
              <div class="m-form-row">
                <span class="m-label">离店日期</span>
                <input type="date" class="m-input" :value="dateStrOf(orderEdit.form.end_date)"
                       @change="orderEdit.form.end_date = parseLocalDate($event.target.value)" />
              </div>
              <div class="m-form-row">
                <span class="m-label">离店时间</span>
                <input type="time" class="m-input" v-model="orderEdit.form.end_hm" />
              </div>
            </template>
            <template v-else>
              <div class="m-form-row">
                <span class="m-label">钟点时长</span>
                <van-stepper v-model="orderEdit.form.rent_hours" :min="0.5" :step="0.5" />
              </div>
            </template>
            <div class="m-form-row">
              <span class="m-label">金额</span>
              <input type="number" class="m-input" v-model.number="orderEdit.form.total_price" step="0.01"
                     @change="orderEdit.form.priceTouched = true" />
              <van-button size="mini" plain type="primary" @click="orderEditResetPrice">自动计算</van-button>
            </div>
            <div class="m-form-row">
              <span class="m-label">状态</span>
              <select class="m-input" v-model="orderEdit.form.status">
                <option v-for="s in ['已预订','已入住','已退房','已取消']" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div class="m-form-row">
              <span class="m-label">备注</span>
              <textarea class="m-input" v-model="orderEdit.form.remark" rows="2"></textarea>
            </div>
          </div>
          <div class="m-popup-actions">
            <van-button size="small" round plain @click="closeOrderEdit">取消</van-button>
            <van-button size="small" round type="primary" :loading="orderEdit.saving"
                        @click="saveOrderEdit">保存修改</van-button>
          </div>
        </template>
      </van-popup>


    <!-- 退房确认 -->
    <el-dialog v-if="!isMobile" v-model="checkoutDialog.visible" title="办理退房" width="480px">
      <el-form label-width="100px" v-if="checkoutDialog.order">
        <el-form-item label="房间">
          {{ checkoutDialog.order.room_number }}
          <template v-if="checkoutDialog.order.guest_name">（{{ checkoutDialog.order.guest_name }}）</template>
        </el-form-item>
        <el-form-item label="计费方式">{{ orderTypeLabel(checkoutDialog.order.order_type) }}</el-form-item>
        <el-form-item label="入住时间">{{ fmtStayTime(checkoutDialog.order, 'start') }}</el-form-item>
        <el-form-item label="订单金额">{{ fmtMoney(checkoutDialog.order.total_price) }}</el-form-item>
        <el-form-item label="实际收取">
          <el-input-number v-model="checkoutDialog.amount" :min="0" :precision="2" style="width: 200px" />
        </el-form-item>
        <el-form-item v-if="checkoutDialog.order" label="实际退房日期">
          <el-date-picker v-model="checkoutDialog.endDate" type="date" value-format="x" style="width: 100%" />
        </el-form-item>
        <el-form-item v-if="checkoutDialog.order" label="实际退房时间">
          <el-time-picker v-model="checkoutDialog.endTime" format="HH:mm" value-format="HH:mm" style="width: 100%" />
        </el-form-item>
        <el-form-item v-if="checkoutDialog.order && (checkoutDialog.order.recorded_income || 0) > 0
                          && checkoutDialog.order.end_timestamp * 1000 > Date.now()"
                      label="退回金额">
          <el-input-number v-model="checkoutDialog.refund" :min="0" :precision="2" style="width: 200px" />
          <span class="form-hint">提前退房退回，将从收入中扣除</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="checkoutDialog.visible = false">取消</el-button>
        <el-button type="success" plain :loading="checkoutDialog.saving" @click="confirmScheduledCheckout">按预定退房</el-button>
        <el-button type="primary" :loading="checkoutDialog.saving" @click="confirmCheckout">确认退房</el-button>
      </template>
    </el-dialog>
      <van-popup v-else v-model:show="checkoutDialog.visible" position="bottom" round class="m-popup">
        <template v-if="checkoutDialog.order">
          <div class="m-popup-title">办理退房</div>
          <van-cell-group inset>
            <van-cell title="房间"
                      :value="checkoutDialog.order.room_number
                              + (checkoutDialog.order.guest_name ? '（' + checkoutDialog.order.guest_name + '）' : '')" />
            <van-cell title="计费方式" :value="orderTypeLabel(checkoutDialog.order.order_type)" />
            <van-cell title="订单金额" :value="fmtMoney(checkoutDialog.order.total_price)" />
            <van-cell title="实际收取">
              <input type="number" class="m-input" v-model.number="checkoutDialog.amount" step="0.01" />
            </van-cell>
            <van-cell v-if="checkoutDialog.order" title="实际退房日期">
              <input type="date" class="m-input" :value="dateStrOf(checkoutDialog.endDate)"
                     @change="checkoutDialog.endDate = parseLocalDate($event.target.value)" />
            </van-cell>
            <van-cell v-if="checkoutDialog.order" title="实际退房时间">
              <input type="time" class="m-input" v-model="checkoutDialog.endTime" />
            </van-cell>
            <van-cell v-if="checkoutDialog.order && (checkoutDialog.order.recorded_income || 0) > 0
                           && checkoutDialog.order.end_timestamp * 1000 > Date.now()" title="退回金额">
              <input type="number" class="m-input" v-model.number="checkoutDialog.refund" step="0.01" />
            </van-cell>
          </van-cell-group>
          <div class="m-popup-actions">
            <van-button size="small" round plain @click="checkoutDialog.visible = false">取消</van-button>
            <van-button size="small" round plain type="success" :loading="checkoutDialog.saving" @click="confirmScheduledCheckout">按预定退房</van-button>
            <van-button size="small" round type="primary" :loading="checkoutDialog.saving"
                        @click="confirmCheckout">确认退房</van-button>
          </div>
        </template>
      </van-popup>

    <!-- 新增门店：PC -->
    <el-dialog v-if="!isMobile" v-model="storeDialog.visible" title="新增门店" width="420px">
      <el-form label-width="80px">
        <el-form-item label="门店名称">
          <el-input v-model="storeDialog.name" placeholder="如：一店 / 二店" maxlength="50" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="storeDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="storeDialog.saving" @click="saveStore">保存</el-button>
      </template>
    </el-dialog>
    <!-- 新增门店：移动端 -->
    <van-popup v-else v-model:show="storeDialog.visible" position="bottom" round class="m-popup">
      <div class="m-popup-title">新增门店</div>
      <div class="m-form">
        <van-field v-model="storeDialog.name" label="门店名称" placeholder="如：一店 / 二店" maxlength="50" />
      </div>
      <div class="m-popup-actions">
        <van-button block round plain @click="storeDialog.visible = false">取消</van-button>
        <van-button block round type="primary" :loading="storeDialog.saving" @click="saveStore">保存</van-button>
      </div>
    </van-popup>

    <!-- 新增/编辑渠道：PC -->
    <el-dialog v-if="!isMobile" v-model="channelDialog.visible"
               :title="channelDialog.isEdit ? '编辑渠道' : '新增渠道'" width="440px">
      <el-form label-width="90px">
        <el-form-item label="渠道名称">
          <el-input v-model="channelDialog.name" placeholder="如：美团 / 线下 / 携程 / 抖音" maxlength="20" />
        </el-form-item>
        <el-form-item label="颜色">
          <div class="color-swatches">
            <span v-for="c in CHANNEL_COLORS" :key="c" class="color-swatch"
                  :class="{ 'is-active': channelDialog.color === c }"
                  :style="{ background: c }" @click="channelDialog.color = c"></span>
          </div>
        </el-form-item>
        <el-form-item label="回款规则">
          <el-select v-model="channelDialog.repay_type" style="width: 100%">
            <el-option label="直接到账" value="direct" />
            <el-option label="几日后到账" value="days" />
            <el-option label="自然周到账" value="week" />
            <el-option label="自然月到账" value="month" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="channelDialog.repay_type === 'days'" label="到账天数">
          <el-input-number v-model="channelDialog.repay_days" :min="0" :precision="0" />
        </el-form-item>
        <el-form-item v-else-if="channelDialog.repay_type === 'week'" label="到账星期">
          <el-select v-model="channelDialog.repay_weekday" style="width: 100%">
            <el-option v-for="w in 7" :key="w" :label="'周' + '一二三四五六日'[w-1]" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item v-else-if="channelDialog.repay_type === 'month'" label="每月到账日">
          <el-input-number v-model="channelDialog.repay_monthday" :min="1" :max="31" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="channelDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="channelDialog.saving" @click="saveChannel">保存</el-button>
      </template>
    </el-dialog>
    <!-- 新增/编辑渠道：移动端 -->
    <van-popup v-else v-model:show="channelDialog.visible" position="bottom" round class="m-popup">
      <div class="m-popup-title">{{ channelDialog.isEdit ? '编辑渠道' : '新增渠道' }}</div>
      <div class="m-form">
        <van-field v-model="channelDialog.name" label="渠道名称"
                   placeholder="如：美团 / 线下 / 携程 / 抖音" maxlength="20" />
        <div class="m-form-row">
          <span class="m-label">颜色</span>
          <div class="color-swatches">
            <span v-for="c in CHANNEL_COLORS" :key="c" class="color-swatch"
                  :class="{ 'is-active': channelDialog.color === c }"
                  :style="{ background: c }" @click="channelDialog.color = c"></span>
          </div>
        </div>
        <div class="m-form-row">
          <span class="m-label">回款规则</span>
          <select class="m-input" v-model="channelDialog.repay_type">
            <option value="direct">直接到账</option>
            <option value="days">几日后到账</option>
            <option value="week">自然周到账</option>
            <option value="month">自然月到账</option>
          </select>
        </div>
        <div v-if="channelDialog.repay_type === 'days'" class="m-form-row">
          <span class="m-label">到账天数</span>
          <input type="number" class="m-input" v-model.number="channelDialog.repay_days" min="0" />
        </div>
        <div v-else-if="channelDialog.repay_type === 'week'" class="m-form-row">
          <span class="m-label">到账星期</span>
          <select class="m-input" v-model.number="channelDialog.repay_weekday">
            <option v-for="w in 7" :key="w" :value="w">{{ '周' + '一二三四五六日'[w-1] }}</option>
          </select>
        </div>
        <div v-else-if="channelDialog.repay_type === 'month'" class="m-form-row">
          <span class="m-label">每月到账日</span>
          <input type="number" class="m-input" v-model.number="channelDialog.repay_monthday" min="1" max="31" />
        </div>
      </div>
      <div class="m-popup-actions">
        <van-button block round plain @click="channelDialog.visible = false">取消</van-button>
        <van-button block round type="primary" :loading="channelDialog.saving" @click="saveChannel">保存</van-button>
      </div>
    </van-popup>


    <!-- 续住：PC -->
    <el-dialog v-if="!isMobile" v-model="extendDialog.visible" title="续住" width="460px">
      <el-form label-width="110px" v-if="extendDialog.order">
        <el-form-item label="订单号">{{ extendDialog.order.order_no }}</el-form-item>
        <el-form-item label="房间">
          {{ extendDialog.order.room_number }}（{{ extendDialog.order.guest_name || '散客' }}）
        </el-form-item>
        <el-form-item label="计费方式">{{ orderTypeLabel(extendDialog.order.order_type) }}</el-form-item>
        <el-form-item label="当前结束">{{ fmtTime(extendDialog.order.end_timestamp) }}</el-form-item>
        <el-form-item :label="'续住' + extendUnitLabel + '数'">
          <el-input-number v-model="extendDialog.count" :min="0.5" :precision="1"
                           :step="extendUnitLabel === '小时' ? 0.5 : 1" />
        </el-form-item>
        <el-form-item label="续住金额">
          <el-input-number v-model="extendDialog.amount" :min="0" :precision="2"
                           @change="extendDialog.amountTouched = true" />
          <span class="form-hint">默认自动计算，可手动修改</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="extendDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="extendDialog.saving" @click="confirmExtend">确认续住</el-button>
      </template>
    </el-dialog>
    <!-- 续住：移动端 -->
    <van-popup v-else v-model:show="extendDialog.visible" position="bottom" round class="m-popup">
      <template v-if="extendDialog.order">
        <div class="m-popup-title">续住</div>
        <van-cell-group inset>
          <van-cell title="订单号" :value="extendDialog.order.order_no" />
          <van-cell title="房间"
                    :value="extendDialog.order.room_number + '（' + (extendDialog.order.guest_name || '散客') + '）'" />
          <van-cell title="当前结束" :value="fmtTime(extendDialog.order.end_timestamp)" />
          <van-cell :title="'续住' + extendUnitLabel + '数'">
            <van-stepper v-model="extendDialog.count" :min="0.5" :step="extendUnitLabel === '小时' ? 0.5 : 1" />
          </van-cell>
          <van-cell title="续住金额">
            <input type="number" class="m-input" v-model.number="extendDialog.amount" step="0.01"
                   @input="extendDialog.amountTouched = true" />
          </van-cell>
        </van-cell-group>
        <div class="m-popup-actions">
          <van-button size="small" round plain @click="extendDialog.visible = false">取消</van-button>
          <van-button size="small" round type="primary" :loading="extendDialog.saving"
                      @click="confirmExtend">确认续住</van-button>
        </div>
      </template>
    </van-popup>

    <!-- 取消订单：PC -->
    <el-dialog v-if="!isMobile" v-model="cancelDialog.visible" title="取消订单" width="440px">
      <div v-if="cancelDialog.order">
        <p class="tip">确定取消订单 {{ cancelDialog.order.order_no }}（{{ displayName(cancelDialog.order.guest_name) }}）吗？</p>
        <el-form v-if="(cancelDialog.order.recorded_income || 0) > 0" label-width="100px" style="margin-top: 10px">
          <el-form-item label="退回金额">
            <el-input-number v-model="cancelDialog.refund" :min="0" :precision="2" style="width: 200px" />
            <span class="form-hint">该订单已计入收入，退回将从收入中扣除</span>
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="cancelDialog.visible = false">再想想</el-button>
        <el-button type="danger" :loading="cancelDialog.saving" @click="confirmCancel">确认取消</el-button>
      </template>
    </el-dialog>
    <!-- 取消订单：移动端 -->
    <van-popup v-else v-model:show="cancelDialog.visible" position="bottom" round class="m-popup">
      <template v-if="cancelDialog.order">
        <div class="m-popup-title">取消订单</div>
        <van-cell-group inset>
          <van-cell title="订单号" :value="cancelDialog.order.order_no" />
          <van-cell title="客人" :value="displayName(cancelDialog.order.guest_name)" />
          <van-cell v-if="(cancelDialog.order.recorded_income || 0) > 0" title="退回金额">
            <input type="number" class="m-input" v-model.number="cancelDialog.refund" step="0.01" />
          </van-cell>
        </van-cell-group>
        <div class="m-popup-actions">
          <van-button size="small" round plain @click="cancelDialog.visible = false">再想想</van-button>
          <van-button size="small" round type="danger" :loading="cancelDialog.saving"
                      @click="confirmCancel">确认取消</van-button>
        </div>
      </template>
    </van-popup>

    <!-- 新增收支：PC -->
    <el-dialog v-if="!isMobile" v-model="expenseDialog.visible"
               :title="expenseDialog.isEdit ? '编辑收支' : '新增收支'" width="480px">
      <el-form label-width="100px">
        <el-form-item label="类型">
          <el-radio-group v-model="expenseDialog.kind">
            <el-radio value="expense">支出</el-radio>
            <el-radio value="income">收入</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="时间">
          <el-date-picker v-model="expenseDialog.date" type="date" value-format="x"
                          placeholder="默认当日" style="width: 100%" />
        </el-form-item>
        <el-form-item label="摘要/理由">
          <el-input v-model="expenseDialog.reason" placeholder="如：水电费、维修、现金收入" maxlength="50" />
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="expenseDialog.amount" :min="0.01" :precision="2" style="width: 200px" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="expenseDialog.remark" type="textarea" :rows="2"
                    maxlength="200" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="expenseDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="expenseDialog.saving" @click="saveExpense">保存</el-button>
      </template>
    </el-dialog>
    <!-- 新增收支：移动端 -->
    <van-popup v-else v-model:show="expenseDialog.visible" position="bottom" round class="m-popup">
      <div class="m-popup-title">{{ expenseDialog.isEdit ? '编辑收支' : '新增收支' }}</div>
      <div class="m-form">
        <div class="m-form-row">
          <span class="m-label">类型</span>
          <van-radio-group v-model="expenseDialog.kind" direction="horizontal">
            <van-radio name="expense">支出</van-radio>
            <van-radio name="income">收入</van-radio>
          </van-radio-group>
        </div>
        <div class="m-form-row">
          <span class="m-label">时间</span>
          <input type="date" class="m-input" :value="dateStrOf(expenseDialog.date)"
                 @change="expenseDialog.date = parseLocalDate($event.target.value)" />
        </div>
        <div class="m-form-row">
          <span class="m-label">摘要</span>
          <input class="m-input" v-model="expenseDialog.reason" placeholder="如：水电费、现金收入" maxlength="50" />
        </div>
            <div class="m-form-row">
              <span class="m-label">金额</span>
              <input type="number" class="m-input" v-model.number="expenseDialog.amount" step="0.01" />
            </div>
            <div class="m-form-row">
              <span class="m-label">备注</span>
              <textarea class="m-input" v-model="expenseDialog.remark" rows="2" maxlength="200" placeholder="选填"></textarea>
        </div>
      </div>
      <div class="m-popup-actions">
        <van-button block round plain @click="expenseDialog.visible = false">取消</van-button>
        <van-button block round type="primary" :loading="expenseDialog.saving" @click="saveExpense">保存</van-button>
      </div>
    </van-popup>

    <!-- 收支详情：PC -->
    <el-dialog v-if="!isMobile" v-model="entryDetail.visible" title="收支详情" width="440px">
      <el-descriptions v-if="entryDetail.entry" :column="1" border size="small">
        <el-descriptions-item label="类型">
          {{ entryDetail.entry.kind === 'income' ? '收入' : '支出' }}
        </el-descriptions-item>
        <el-descriptions-item label="金额">
          <span :class="entryDetail.entry.kind === 'income' ? 'pos' : 'neg'">
            {{ fmtMoney(entryDetail.entry.kind === 'income' ? entryDetail.entry.income : entryDetail.entry.expense) }}
          </span>
        </el-descriptions-item>
        <el-descriptions-item label="摘要/理由">{{ entryDetail.entry.reason || '-' }}</el-descriptions-item>
        <el-descriptions-item label="备注">{{ entryDetail.entry.remark || '-' }}</el-descriptions-item>
        <el-descriptions-item label="时间">{{ fmtTime(entryDetail.entry.checkout_time) }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="entryDetail.visible = false">关闭</el-button>
        <el-button type="primary" plain @click="openEditExpense(entryDetail.entry)">编辑</el-button>
        <el-button type="danger" @click="removeExpense">删除</el-button>
      </template>
    </el-dialog>
    <!-- 收支详情：移动端 -->
    <van-popup v-else v-model:show="entryDetail.visible" position="bottom" round class="m-popup">
      <template v-if="entryDetail.entry">
        <div class="m-popup-title">收支详情</div>
        <van-cell-group inset>
          <van-cell title="类型" :value="entryDetail.entry.kind === 'income' ? '收入' : '支出'" />
          <van-cell title="金额"
                    :value="fmtMoney(entryDetail.entry.kind === 'income' ? entryDetail.entry.income : entryDetail.entry.expense)" />
          <van-cell title="摘要/理由" :value="entryDetail.entry.reason || '-'" />
          <van-cell title="备注" :value="entryDetail.entry.remark || '-'" />
          <van-cell title="时间" :value="fmtTime(entryDetail.entry.checkout_time)" />
        </van-cell-group>
        <div class="m-popup-actions">
          <van-button size="small" round plain @click="entryDetail.visible = false">关闭</van-button>
          <van-button size="small" round plain type="primary"
                      @click="openEditExpense(entryDetail.entry)">编辑</van-button>
          <van-button size="small" round type="danger" @click="removeExpense">删除</van-button>
        </div>
      </template>
    </van-popup>
  </div>
  `,
}

createApp(App)
  .use(ElementPlus, { locale: zhCn })
  .mount('#app')


# -*- coding: utf-8 -*-
"""Pydantic 请求/响应模型。"""

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, model_validator


class RoomCategory(str, Enum):
    """房间品类（仅用于展示，与计费方式无关）。"""
    STANDARD = "标准间"
    KING = "大床房"
    SUITE = "套房"
    TWIN = "双床房"


class RoomStatus(str, Enum):
    """房间状态。"""
    AVAILABLE = "空闲"
    RESERVED = "已预订"
    CHECKED_IN = "已入住"
    MAINTENANCE = "维修"


class OrderType(str, Enum):
    """订单类型。"""
    FULL_DAY = "full_day"
    HOURLY = "hourly"
    LONG_TERM = "long_term"


class OrderStatus(str, Enum):
    """订单状态。"""
    RESERVED = "已预订"
    CHECKED_IN = "已入住"
    CHECKED_OUT = "已退房"
    CANCELLED = "已取消"


# ---------------- 房间 ----------------

class StoreCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=50, description="门店名称")


class StoreUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=50, description="门店名称")


class StoreResponse(BaseModel):
    id: int
    name: str
    created_at: int


class RoomCreate(BaseModel):
    room_number: str = Field(..., min_length=1, max_length=20, description="房间号")
    room_name: str = Field(..., min_length=1, max_length=50, description="房间名称")
    room_category: RoomCategory = Field(RoomCategory.STANDARD, description="房间品类：标准间/大床房/套房/双床房")
    base_price: float = Field(..., ge=0, description="全日租价格（元/晚）")
    hourly_price: float = Field(0, ge=0, description="钟点房价格（元/小时），0 表示按全日价/24 自动折算")
    status: RoomStatus = Field(RoomStatus.AVAILABLE, description="房间状态")
    store_id: int = Field(1, ge=1, description="所属门店")


class RoomUpdate(BaseModel):
    room_number: Optional[str] = Field(None, min_length=1, max_length=20)
    room_name: Optional[str] = Field(None, min_length=1, max_length=50)
    room_category: Optional[RoomCategory] = None
    base_price: Optional[float] = Field(None, ge=0)
    hourly_price: Optional[float] = Field(None, ge=0)
    status: Optional[RoomStatus] = None
    is_active: Optional[int] = Field(None, ge=0, le=1)
    store_id: Optional[int] = Field(None, ge=1)


class RoomResponse(BaseModel):
    id: int
    room_number: str
    room_name: str
    room_category: RoomCategory
    base_price: float
    hourly_price: float = 0
    status: RoomStatus
    is_active: int = 1
    store_id: int = 1
    active_orders: int = 0
    created_at: int


# ---------------- 入住渠道 ----------------

class ChannelCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=20, description="渠道名称")
    color: str = Field("#909399", min_length=3, max_length=9, description="渠道颜色（十六进制）")
    sort_order: int = Field(0, ge=0)


class ChannelUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=20)
    color: Optional[str] = Field(None, min_length=3, max_length=9)
    sort_order: Optional[int] = Field(None, ge=0)


class ChannelResponse(BaseModel):
    id: int
    name: str
    color: str
    sort_order: int


# ---------------- 订单 ----------------

class OrderCreate(BaseModel):
    room_id: int
    order_type: OrderType
    settle_mode: str = Field("once", description="结算方式：once 一次性结算 / daily 日结")
    daily_price: Optional[float] = Field(None, ge=0, description="订单内日单价（日租/长租，元/日）")
    guest_name: str = Field("", max_length=50, description="客人姓名（选填，空则显示散客）")
    guest_phone: str = Field("", max_length=30, description="联系电话")
    guest_source: str = Field("", max_length=20, description="客人来源：美团/线下/携程/其他")
    remark: str = Field("", max_length=200, description="备注")
    start_timestamp: int = Field(..., ge=0, description="入住/开始时间（Unix 秒）")
    end_timestamp: Optional[int] = Field(None, ge=0, description="退房/结束时间（全日租必填）")
    rent_hours: Optional[float] = Field(None, gt=0, description="租用时长（钟点房必填）")
    total_price: Optional[float] = Field(None, ge=0, description="手动指定金额；不填自动计算")
    status: OrderStatus = Field(OrderStatus.RESERVED, description="新订单状态：已预订 / 已入住")

    @model_validator(mode="after")
    def _check_fields(self):
        if self.settle_mode not in ("once", "daily", "ondeparture"):
            raise ValueError("结算方式只能是 once / daily / ondeparture")
        if self.end_timestamp is not None and self.end_timestamp <= self.start_timestamp:
            raise ValueError("结束时间必须晚于开始时间")
        if self.order_type in (OrderType.FULL_DAY, OrderType.LONG_TERM) and self.end_timestamp is None:
            raise ValueError("全日租/长租订单必须提供退房时间")
        if self.order_type == OrderType.HOURLY and self.rent_hours is None:
            raise ValueError("钟点房订单必须提供租用时长")
        return self


class OrderUpdate(BaseModel):
    room_id: Optional[int] = None
    order_type: Optional[OrderType] = None
    settle_mode: Optional[str] = Field(None, description="结算方式：once / daily")
    daily_price: Optional[float] = Field(None, ge=0)
    guest_name: Optional[str] = Field(None, max_length=50)
    guest_phone: Optional[str] = Field(None, max_length=30)
    guest_source: Optional[str] = Field(None, max_length=20)
    remark: Optional[str] = Field(None, max_length=200)
    start_timestamp: Optional[int] = Field(None, ge=0)
    end_timestamp: Optional[int] = Field(None, ge=0)
    rent_hours: Optional[float] = Field(None, gt=0)
    total_price: Optional[float] = Field(None, ge=0)
    status: Optional[OrderStatus] = None


class OrderResponse(BaseModel):
    id: int
    order_no: str = ""
    room_id: int
    order_type: OrderType
    settle_mode: str = "once"
    daily_discount: float = 0
    daily_price: float = 0
    refund_amount: float = 0
    adjust_amount: float = 0
    recorded_income: float = 0
    guest_name: str
    guest_phone: str
    guest_source: str = ""
    remark: str = ""
    start_timestamp: int
    end_timestamp: int
    rent_hours: Optional[float] = None
    total_price: float
    extra_charge: float = 0
    status: OrderStatus
    created_at: int
    updated_at: int
    room_number: Optional[str] = None
    room_name: Optional[str] = None
    base_price: Optional[float] = None


class ConflictCheckRequest(BaseModel):
    """冲突检测请求：检查某房间在时间段内是否已有进行中订单。"""
    room_id: int
    start_timestamp: int = Field(..., ge=0)
    end_timestamp: int = Field(..., ge=0)
    exclude_order_id: Optional[int] = Field(None, description="需要排除的订单 ID（编辑订单时使用）")
    order_type: Optional[OrderType] = Field(None, description="新订单类型（全日租/钟点房），用于时间归一化")
    rent_hours: Optional[float] = Field(None, gt=0, description="钟点房租用时长（小时）")

    @model_validator(mode="after")
    def _check_time(self):
        if self.end_timestamp <= self.start_timestamp:
            raise ValueError("结束时间必须晚于开始时间")
        return self


class CheckoutRequest(BaseModel):
    """退房请求：无需选择退房时间（默认当前时间），可手动修改实际收取金额。"""
    end_timestamp: Optional[int] = Field(None, ge=0, description="实际退房时间（Unix 秒）")
    total_price: Optional[float] = Field(None, ge=0, description="实际收取金额；不填保持原订单金额")
    refund_amount: Optional[float] = Field(None, ge=0, description="提前退房退回金额（元），从收入中扣除")
    confirm: bool = Field(False, description="二次确认标记，必须为 true 才允许退房")


class CancelRequest(BaseModel):
    """取消订单请求：已计入收入的订单可填退回金额，从收入中扣除。"""
    refund_amount: Optional[float] = Field(None, ge=0, description="退回金额（元）")
    confirm: bool = Field(False, description="二次确认标记，必须为 true 才允许取消")


class ExtendRequest(BaseModel):
    """续住请求：全日租/长租按天续住，钟点房按小时续住。"""
    count: float = Field(..., gt=0, description="续住数量（全日租/长租为天数，钟点房为小时数）")
    amount: Optional[float] = Field(None, ge=0, description="续住金额（可手动调整，不填自动计算）")


class PaymentCreate(BaseModel):
    """日结收款标记：按日期标记已收当日款（金额可修改），同一日期重复提交为更新。"""
    pay_date: int = Field(..., ge=0, description="收款日期（当天零点 Unix 秒）")
    amount: float = Field(..., ge=0, description="实收金额")


class PaymentResponse(BaseModel):
    id: int
    order_id: int
    amount: float
    pay_date: int
    remark: str = ""
    created_at: int


# ---------------- 设置 / 统计 ----------------

class SettingsItem(BaseModel):
    key: str
    value: str
    description: str = ""


class SettingsUpdate(BaseModel):
    items: dict[str, str]


class StatsOut(BaseModel):
    """工作台统计（/api/stats）。"""
    total_rooms: int
    rooms_by_status: dict[str, int]
    active_orders: int
    today_new_orders: int
    today_checkout_count: int
    today_revenue: float
    upcoming_arrivals: int


class TodayStatisticsOut(BaseModel):
    """今日统计（/api/statistics/today）。"""
    expected_arrivals: int
    expected_checkouts: int
    today_revenue: float


class SegmentOut(BaseModel):
    """房间在某个自然日内的占用时间段。"""
    start: int
    end: int
    order_type: OrderType
    settle_mode: str = "once"
    daily_discount: float = 0
    daily_price: float = 0
    paid: bool = False
    is_checkout_day: bool = False
    checkout_day: int = 0
    status: OrderStatus
    order_no: str = ""
    order_id: int = 0
    guest_name: str = ""
    guest_source: str = ""
    total_price: float = 0


class RoomStatusDay(BaseModel):
    """单个房间在某日期范围内的逐日状态。"""
    room_id: int
    room_number: str
    room_name: str
    room_category: RoomCategory
    base_price: float
    statuses: dict[str, str]
    segments: dict[str, list[SegmentOut]]


class RoomStatusRangeOut(BaseModel):
    """房态图数据（/api/room-status）。"""
    start_date: str
    end_date: str
    days: list[str]
    rooms: list[RoomStatusDay]


class ExpenseCreate(BaseModel):
    """手动收支：kind 区分收入/支出，可设置时间（默认当日）、理由、金额、备注、客人、房号。"""
    kind: str = Field("expense", description="收支类型：income 收入 / expense 支出")
    expense_date: int = Field(..., ge=0, description="支出日期（当天零点 Unix 秒）")
    reason: str = Field("", max_length=50, description="支出理由")
    amount: float = Field(..., gt=0, description="支出金额")
    remark: str = Field("", max_length=200, description="备注")
    guest_name: str = Field("", max_length=50, description="客人姓名（选填）")
    room_number: str = Field("", max_length=20, description="房号（选填）")
    store_id: int = Field(1, ge=1, description="所属门店")


class ExpenseResponse(BaseModel):
    id: int
    kind: str = "expense"
    reason: str
    remark: str
    guest_name: str = ""
    room_number: str = ""
    amount: float
    expense_date: int
    store_id: int
    created_at: int


class ExpenseUpdate(BaseModel):
    """编辑手动收支条目。"""
    kind: Optional[str] = Field(None, description="收支类型：income 收入 / expense 支出")
    expense_date: Optional[int] = Field(None, ge=0)
    reason: Optional[str] = Field(None, max_length=50)
    amount: Optional[float] = Field(None, gt=0)
    remark: Optional[str] = Field(None, max_length=200)
    guest_name: Optional[str] = Field(None, max_length=50)
    room_number: Optional[str] = Field(None, max_length=20)


class RevenueItemOut(BaseModel):
    """收支明细项：
    - 年/月/自定义：期间（YYYY-MM / YYYY-MM-DD）汇总的收入/支出/净收益；
    - 日：每一笔收入或支出（kind 区分 income / expense）。
    """
    period: str
    income: float = 0
    expense: float = 0
    net: float = 0
    count: int = 0
    kind: str = ""
    reason: str = ""
    remark: str = ""
    expense_id: Optional[int] = None
    order_id: Optional[int] = None
    room_number: str = ""
    guest_name: str = ""
    guest_source: str = ""
    checkout_time: Optional[int] = None


class RevenueOut(BaseModel):
    """收支统计（按门店 + 时间范围筛选）。"""
    total_income: float
    total_expense: float
    net: float
    income_count: int
    gran: str
    items: list[RevenueItemOut]

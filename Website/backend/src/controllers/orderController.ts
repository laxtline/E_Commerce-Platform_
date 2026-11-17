import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import { OrderModel } from '../models/Order.js';
import { ProductModel } from '../models/Product.js';
import { UserModel } from '../models/User.js';
import { CouponModel } from '../models/Coupon.js';
import { CouponUsageModel } from '../models/CouponUsage.js';
import { ReturnModel } from '../models/Return.js';
import { RefundModel } from '../models/Refund.js';
import { ApiError } from '../utils/ApiError.js';
import { cursorFilter, cursorPage, getPageParams } from '../utils/pagination.js';
import { sendOrderPlacedEmail, sendOrderStatusEmail } from '../utils/email.js';
import { resolveCoupon } from '../services/coupons.js';
import { priceCart } from '../services/cartPricing.js';
import { money } from '@shared/pricing.js';
import { notifyNewOrder, notifyOrderStatusChange, notifyAdmins } from '../services/push.js';
import { getEncryptionService } from '../services/encryption.js';
import { env, razorpayEnabled } from '../config/env.js';
import { calculateDeliveryFee as dbCalculateDeliveryFee } from '../services/delivery.js';
import type { OrderStatus, ShippingAddress, ReturnStatus } from '@shared/types/index.js';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

function razorpayAuthHeader(): string {
  const token = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64');
  return `Basic ${token}`;
}

const sort = { field: 'createdAt', direction: -1, kind: 'date' } as const;
// TODO: move STATUS_FLOW to shared constants so frontend/admin stay in sync
const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  PLACED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

function validateAddress(input: unknown): ShippingAddress {
  const a = (input ?? {}) as Record<string, string>;
  for (const key of ['fullName', 'phone', 'line1', 'city', 'state', 'pincode']) {
    if (typeof a[key] !== 'string' || !a[key].trim()) throw new ApiError(400, `Shipping address: ${key} is required.`);
  }
  if (!/^[1-9]\d{5}$/.test(a.pincode.trim())) throw new ApiError(400, 'Pincode must be 6 digits.');
  if (!/^[6-9]\d{9}$/.test(a.phone.trim())) throw new ApiError(400, 'A valid 10-digit mobile number is required.');
  return { fullName: a.fullName.trim(), phone: a.phone.trim(), line1: a.line1.trim(), line2: (a.line2 ?? '').trim(),
    city: a.city.trim(), state: a.state.trim(), pincode: a.pincode.trim() };
}

function addStatusHistory(order: any, status: OrderStatus, note: string, userId: string) {
  const history = order.statusHistory ?? [];
  history.push({ status, timestamp: new Date(), note });
  order.statusHistory = history;
}

export async function createOrder(req: Request, res: Response) {
  const userId = String(req.user!._id);
  const shippingAddress = validateAddress(req.body.shippingAddress);
  const paymentMethod = req.body.paymentMethod === 'RAZORPAY' ? 'RAZORPAY' : 'COD';
  const notes = String(req.body.notes ?? '').slice(0, 500);
  const code = String(req.body.couponCode ?? '').trim();

  // Validate COD availability for the pincode using database config
  const { codAvailable, serviceable } = await dbCalculateDeliveryFee(0, shippingAddress.pincode);
  if (!serviceable) {
    throw new ApiError(400, `Delivery is not available to pincode ${shippingAddress.pincode}.`);
  }
  if (paymentMethod === 'COD' && !codAvailable) {
    throw new ApiError(400, `Cash on Delivery is not available for pincode ${shippingAddress.pincode}. Please choose online payment.`);
  }

  // transaction prevents overselling, double checkout, coupon limit races
  // For RAZORPAY: reserve stock now, deduct on payment.captured webhook
  // For COD: deduct stock immediately (no payment gateway)
  const order = await mongoose.connection.transaction(async (session) => {
    const priced = await priceCart(userId, session, shippingAddress.pincode);
    const resolved = code ? await resolveCoupon(code, userId, priced, session) : null;

    if (paymentMethod === 'RAZORPAY') {
      // Reserve stock for online payment orders
      for (const line of priced.items) {
        const result = await ProductModel.updateOne(
          { _id: line.product, isActive: true, $expr: { $gte: ['$stock', { $add: ['$reservedStock', line.quantity] }] } },
          { $inc: { reservedStock: line.quantity } },
          { session }
        );
        if (!result.modifiedCount) throw new ApiError(409, `"${line.title}" has insufficient stock. Update your cart.`);
      }
    } else {
      // COD: deduct stock immediately
      for (const line of priced.items) {
        const stock = await ProductModel.updateOne({ _id: line.product, isActive: true, stock: { $gte: line.quantity } },
          { $inc: { stock: -line.quantity } }, { session });
        if (!stock.modifiedCount) throw new ApiError(409, `"${line.title}" has insufficient stock. Update your cart.`);
      }
    }

    const discount = resolved?.discount ?? 0;
    const now = new Date();
    const heavyProductFee = priced.heavyProductFee ?? 0;
    const [created] = await OrderModel.create([{
      user: userId, items: priced.items, shippingAddress, paymentMethod, paymentStatus: 'PENDING', status: 'PLACED',
      itemsTotal: priced.itemsTotal, deliveryFee: priced.deliveryFee, heavyProductFee, discount,
      coupon: resolved?.coupon._id ?? null, couponCode: resolved?.coupon.code ?? '',
      couponSnapshot: resolved ? { code: resolved.coupon.code, description: resolved.coupon.description,
        type: resolved.coupon.type, value: resolved.coupon.value, maxDiscount: resolved.coupon.maxDiscount,
        scope: resolved.coupon.scope, eligibleTotal: resolved.eligibleTotal } : null,
      total: money(priced.itemsTotal + priced.deliveryFee + heavyProductFee - discount), notes,
      statusHistory: [{ status: 'PLACED', timestamp: now, note: 'Order placed' }],
    }], { session });
    if (resolved) {
      await CouponModel.updateOne({ _id: resolved.coupon._id },
        { $inc: { totalUses: 1, totalDiscount: discount } }, { session });
      await CouponUsageModel.create([{
        coupon: resolved.coupon._id, user: userId, order: created._id,
        couponCode: resolved.coupon.code, customerName: req.user!.name,
        customerEmail: req.user!.email, discount,
        orderTotal: created.total,
      }], { session });
    }
    priced.cart.set('items', []);
    priced.cart.lastUpdatedAt = new Date();
    await priced.cart.save({ session });
    return created;
  });

  // fire and forget
  void sendOrderPlacedEmail(req.user!.email, order);
  void notifyNewOrder(order._id.toString(), req.user!.name, order.total);

  res.status(201).json({ success: true, data: order, message: 'Order placed successfully.' });
  // console.log('[order] created:', order._id); // debug
}

export async function listMyOrders(req: Request, res: Response) {
  const { page, limit, skip } = getPageParams(req, 10, 50);
  const filter = { user: req.user!._id };
  const scope = { user: String(req.user!._id) };
  const [rows, total] = await Promise.all([
    OrderModel.find({ $and: [filter, cursorFilter(req, sort, scope)] }).sort({ createdAt: -1, _id: -1 })
      .skip(req.query.cursor ? 0 : skip).limit(limit + 1), OrderModel.countDocuments(filter),
  ]);
  res.json({ success: true, data: cursorPage(rows, total, page, limit, sort, scope) });
}

export async function getOrder(req: Request, res: Response) {
  const order = await OrderModel.findById(req.params.id).populate('user', 'name email');
  if (!order) throw new ApiError(404, 'Order not found.');
  if (String(order.user._id) !== String(req.user!._id) && req.user!.role !== 'ADMIN') throw new ApiError(403, 'Not allowed.');
  res.json({ success: true, data: order });
}

async function changeStatus(req: Request, next: OrderStatus, ownerOnly: boolean) {
  const order = await mongoose.connection.transaction(async (session) => {
    const current = await OrderModel.findById(req.params.id).session(session);
    if (!current) throw new ApiError(404, 'Order not found.');
    if (ownerOnly && String(current.user) !== String(req.user!._id)) throw new ApiError(403, 'Not allowed.');
    if (!STATUS_FLOW[current.status as OrderStatus]?.includes(next)) throw new ApiError(400, `Cannot change status from ${current.status} to ${next}.`);

    // Prevent fulfilling unpaid prepaid orders
    if (current.paymentMethod === 'RAZORPAY' && current.paymentStatus !== 'PAID') {
      // Allow cancellation of unpaid orders, but block fulfillment
      if (next !== 'CANCELLED') {
        throw new ApiError(400, 'Cannot advance unpaid online order. Payment must be completed first.');
      }
    }

    // Prevent using Razorpay when gateway is disabled
    if (current.paymentMethod === 'RAZORPAY' && !razorpayEnabled) {
      if (next !== 'CANCELLED') {
        throw new ApiError(503, 'Online payment is not available. Cannot process this order.');
      }
    }

    if (next === 'CANCELLED') {
      for (const line of current.items) {
        if (line.product) {
          if (current.paymentMethod === 'RAZORPAY') {
            // Release reserved stock for online payment orders
            await ProductModel.updateOne({ _id: line.product }, { $inc: { reservedStock: -line.quantity } }, { session });
          } else {
            // Restore actual stock for COD orders
            await ProductModel.updateOne({ _id: line.product }, { $inc: { stock: line.quantity } }, { session });
          }
        }
      }
    }
    const note = String(req.body.note ?? '').slice(0, 500);
    current.status = next;
    addStatusHistory(current, next, note || `Status changed to ${next}`, String(req.user!._id));

    // For COD, do NOT auto-mark as PAID on DELIVERED - requires separate cash collection
    // Payment collection for COD should be tracked separately
    if (next === 'DELIVERED' && current.paymentMethod === 'COD' && current.paymentStatus !== 'PAID') {
      current.paymentStatus = 'PENDING'; // Keep as PENDING for cash collection tracking
    }
    await current.save({ session });
    return current;
  });
  const owner = await UserModel.findById(order.user).select('email');
  if (owner?.email) void sendOrderStatusEmail(owner.email, order);
  // push for admin-initiated status changes
  if (!ownerOnly) {
    void notifyOrderStatusChange(order._id.toString(), order.status, order.shippingAddress.fullName);
  }
  return order;
}

export async function cancelOrder(req: Request, res: Response) {
  const order = await changeStatus(req, 'CANCELLED', true);
  res.json({ success: true, data: order, message: 'Order cancelled.' });
}

export async function listAllOrders(req: Request, res: Response) {
  const { page, limit, skip } = getPageParams(req, 15, 100);
  const filter: Record<string, unknown> = {};
  const status = String(req.query.status ?? '').toUpperCase();
  if (status && !(status in STATUS_FLOW)) throw new ApiError(400, 'Invalid order status.');
  if (status) filter.status = status;
  const [rows, total] = await Promise.all([
    OrderModel.find({ $and: [filter, cursorFilter(req, sort, filter)] }).populate('user', 'name email')
      .sort({ createdAt: -1, _id: -1 }).skip(req.query.cursor ? 0 : skip).limit(limit + 1),
    OrderModel.countDocuments(filter),
  ]);
  res.json({ success: true, data: cursorPage(rows, total, page, limit, sort, filter) });
}

export async function updateOrderStatus(req: Request, res: Response) {
  const next = String(req.body.status).toUpperCase() as OrderStatus;
  const order = await changeStatus(req, next, false);
  res.json({ success: true, data: order, message: `Order marked ${next}.` });
}

export async function orderAnalytics(_req: Request, res: Response) {
  // 30-day window, IST dates. MongoDB aggregates, no order arrays in memory.
  const since = new Date(Date.now() - 30 * 86400000);
  // Exclude cancelled orders and unpaid/failed online orders from revenue
  // For COD: only count as revenue when cash is collected (paymentStatus === 'PAID')
  // For RAZORPAY: only count when paymentStatus === 'PAID'
  const match = {
    status: { $ne: 'CANCELLED' },
    createdAt: { $gte: since },
    $or: [
      { paymentMethod: 'COD', paymentStatus: 'PAID' }, // Only collected COD orders
      { paymentMethod: 'RAZORPAY', paymentStatus: 'PAID' }, // Only PAID online orders (exclude FAILED)
    ],
  };
  const [days, top, coupons] = await Promise.all([
    OrderModel.aggregate([
      { $match: match }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' } },
        revenue: { $sum: '$total' }, orders: { $sum: 1 } } }, { $sort: { _id: 1 } },
    ]),
    OrderModel.aggregate([
      { $match: match }, { $unwind: '$items' }, { $group: { _id: '$items.product', title: { $first: '$items.title' },
        qty: { $sum: '$items.quantity' }, revenue: { $sum: '$items.lineTotal' } } }, { $sort: { qty: -1, _id: 1 } }, { $limit: 10 },
    ]).allowDiskUse(true),
    OrderModel.aggregate([
      { $match: { ...match, couponCode: { $ne: '' } } }, { $group: { _id: '$couponCode', uses: { $sum: 1 }, discount: { $sum: '$discount' } } },
      { $sort: { uses: -1, _id: 1 } }, { $limit: 10 },
    ]).allowDiskUse(true),
  ]);
  res.json({ success: true, data: {
    revenueByDay: days.map((r) => ({ date: r._id, revenue: r.revenue, orders: r.orders })),
    topProducts: top.map((p) => ({ title: p.title, qty: p.qty, revenue: p.revenue })),
    couponUsage: coupons.map((c) => ({ code: c._id, uses: c.uses, discount: c.discount })),
  } });
}

export async function orderStats(_req: Request, res: Response) {
  // Match the same criteria as orderAnalytics: exclude cancelled and unpaid/failed online orders from revenue
  // For COD: only count as revenue when cash is collected (paymentStatus === 'PAID')
  // For RAZORPAY: only count when paymentStatus === 'PAID'
  const match = {
    $or: [
      { paymentMethod: 'COD', paymentStatus: 'PAID' },
      { paymentMethod: 'RAZORPAY', paymentStatus: 'PAID' }, // Only PAID online orders (exclude FAILED)
    ],
  };
  const [rows] = await OrderModel.aggregate([{ $facet: {
    statuses: [{ $match: { status: { $ne: 'CANCELLED' } } }, { $group: { _id: '$status', count: { $sum: 1 } } }],
    sales: [{ $match: { ...match, status: { $ne: 'CANCELLED' } } }, { $group: { _id: null,
      sales: { $sum: { $sum: '$items.quantity' } }, revenue: { $sum: '$total' },
      couponUses: { $sum: { $cond: [{ $ne: ['$couponCode', ''] }, 1, 0] } }, discountGiven: { $sum: '$discount' },
    } }],
  } }]);
  const statusCounts: Record<string, number> = {};
  for (const r of rows?.statuses ?? []) statusCounts[r._id] = r.count;
  res.json({ success: true, data: { totalOrders: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    revenue: rows?.sales[0]?.revenue ?? 0, sales: rows?.sales[0]?.sales ?? 0,
    couponUses: rows?.sales[0]?.couponUses ?? 0, discountGiven: rows?.sales[0]?.discountGiven ?? 0, statusCounts } });
}

// PUT /api/orders/:id/courier — Admin only. Update courier name, tracking ID, and tracking URL.
export async function updateCourierInfo(req: Request, res: Response) {
  const { courierName, trackingId, trackingUrl } = req.body as {
    courierName?: string; trackingId?: string; trackingUrl?: string;
  };
  if (!courierName?.trim() && !trackingId?.trim()) {
    throw new ApiError(400, 'At least courier name or tracking ID is required.');
  }

  // First get the current order to know its status
  const currentOrder = await OrderModel.findById(req.params.id);
  if (!currentOrder) throw new ApiError(404, 'Order not found.');

  const updated = await OrderModel.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        'courierInfo.name': courierName?.trim() ?? '',
        'courierInfo.trackingId': trackingId?.trim() ?? '',
        'courierInfo.trackingUrl': trackingUrl?.trim() ?? '',
      },
      $push: { statusHistory: { status: currentOrder.status, timestamp: new Date(), note: `Courier info updated: ${courierName} - ${trackingId}` } },
    },
    { new: true }
  ).populate('user', 'name email');

  if (!updated) throw new ApiError(404, 'Order not found.');
  const order = updated;

  // Notify customer of tracking update
  const owner = await UserModel.findById(order.user).select('email');
  if (owner?.email) void sendOrderStatusEmail(owner.email, order);
  void notifyOrderStatusChange(order._id.toString(), `Tracking: ${courierName}`, order.shippingAddress.fullName);

  res.json({ success: true, data: order, message: 'Courier info updated.' });
}

// POST /api/orders/:id/collect-cash — Admin: mark COD order as cash collected.
export async function collectCash(req: Request, res: Response) {
  const order = await OrderModel.findById(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found.');

  if (order.paymentMethod !== 'COD') {
    throw new ApiError(400, 'Cash collection is only for COD orders.');
  }

  if (order.status !== 'DELIVERED') {
    throw new ApiError(400, 'Cash can only be collected for delivered orders.');
  }

  if (order.cashCollectedAt) {
    throw new ApiError(400, 'Cash already collected for this order.');
  }

  order.paymentStatus = 'PAID';
  order.cashCollectedAt = new Date();
  order.collectedBy = req.user!._id;
  order.statusHistory.push({
    status: order.status,
    timestamp: new Date(),
    note: `Cash collected by admin ${req.user!._id}`,
  });
  await order.save();

  res.json({ success: true, data: order, message: 'Cash collection recorded.' });
}

// POST /api/orders/:id/return — Customer requests a return.
export async function requestReturn(req: Request, res: Response) {
  const userId = String(req.user!._id);
  const { reason, pickupAddress } = req.body as { reason: string; pickupAddress: ShippingAddress };

  if (!reason?.trim()) throw new ApiError(400, 'Return reason is required.');

  const order = await OrderModel.findById(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found.');
  if (String(order.user) !== userId) throw new ApiError(403, 'Not allowed.');
  if (order.status !== 'DELIVERED') throw new ApiError(400, 'Only delivered orders can be returned.');
  if (order.returnRequest?.status && order.returnRequest.status !== 'REJECTED') {
    throw new ApiError(400, 'A return request already exists for this order.');
  }

  // Validate pickup address
  const validatedAddress = validateAddress(pickupAddress);

  // Create return request
  // FIXME: validate that items being returned actually exist in order
  const returnDoc = await ReturnModel.create({
    order: order._id,
    user: userId,
    items: order.items.map((item) => ({
      product: item.product,
      title: item.title,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
    reason: reason.trim(),
    pickupAddress: validatedAddress,
    status: 'REQUESTED',
    statusHistory: [{ status: 'REQUESTED', timestamp: new Date(), note: 'Return requested by customer' }],
  });

  // Update order with return request
  order.returnRequest = {
    requestedAt: new Date(),
    reason: reason.trim(),
    pickupAddress: validatedAddress,
    status: 'REQUESTED',
    adminNotes: '',
  };
  addStatusHistory(order, 'DELIVERED', `Return requested: ${reason.trim()}`, userId);
  await order.save();

  // Notify admins
  void notifyAdmins(
    '🔄 Return Requested',
    `${req.user!.name} requested return for order #${order._id.toString().slice(-6).toUpperCase()}`,
    { type: 'return_request', orderId: order._id.toString(), returnId: returnDoc._id.toString() }
  );

  res.status(201).json({ success: true, data: returnDoc, message: 'Return requested. Admin will review.' });
}

// GET /api/orders/:id/return — Get return status for an order (customer or admin).
export async function getReturnStatus(req: Request, res: Response) {
  const order = await OrderModel.findById(req.params.id).select('returnRequest user');
  if (!order) throw new ApiError(404, 'Order not found.');
  if (String(order.user) !== String(req.user!._id) && req.user!.role !== 'ADMIN') {
    throw new ApiError(403, 'Not allowed.');
  }

  // Also get the Return document for full history
  const returnDoc = await ReturnModel.findOne({ order: order._id })
    .populate('refund')
    .lean();

  res.json({ success: true, data: { returnRequest: order.returnRequest, returnDoc } });
}

// GET /api/admin/returns — Admin: list all returns with filters.
export async function listReturns(req: Request, res: Response) {
  const { page, limit, skip } = getPageParams(req, 20, 100);
  const status = String(req.query.status ?? '').toUpperCase();
  const filter: Record<string, unknown> = {};
  if (status && ['REQUESTED', 'APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'REFUND_INITIATED', 'REFUNDED', 'REJECTED'].includes(status)) {
    filter.status = status;
  }

  const [rows, total] = await Promise.all([
    ReturnModel.find(filter)
      .populate('order', 'itemsTotal total couponCode')
      .populate('user', 'name email')
      .sort({ createdAt: -1, _id: -1 })
      .skip(req.query.cursor ? 0 : skip)
      .limit(limit + 1),
    ReturnModel.countDocuments(filter),
  ]);

  res.json({ success: true, data: cursorPage(rows, total, page, limit, sort, filter) });
}

// Return state machine - enforces valid transitions
const RETURN_STATUS_FLOW: Record<ReturnStatus, ReturnStatus[]> = {
  REQUESTED: ['APPROVED', 'REJECTED'],
  APPROVED: ['PICKUP_SCHEDULED', 'REJECTED'],
  PICKUP_SCHEDULED: ['PICKED_UP', 'REJECTED'],
  PICKED_UP: ['RECEIVED', 'REJECTED'],
  RECEIVED: ['REFUND_INITIATED', 'REJECTED'],
  REFUND_INITIATED: ['REFUNDED'],
  REFUNDED: [],
  REJECTED: [],
};

// PUT /api/admin/returns/:id — Admin: update return status.
export async function updateReturnStatus(req: Request, res: Response) {
  const next = String(req.body.status).toUpperCase() as ReturnStatus;
  const validStatuses = ['APPROVED', 'PICKUP_SCHEDULED', 'PICKED_UP', 'RECEIVED', 'REFUND_INITIATED', 'REFUNDED', 'REJECTED'];
  if (!validStatuses.includes(next)) throw new ApiError(400, 'Invalid return status.');

  const adminNotes = String(req.body.adminNotes ?? '').slice(0, 500);
  const courierName = String(req.body.courierName ?? '').trim();
  const trackingId = String(req.body.trackingId ?? '').trim();
  const trackingUrl = String(req.body.trackingUrl ?? '').trim();

  const returnDoc = await ReturnModel.findById(req.params.id).populate('order').populate('user', 'name email');
  if (!returnDoc) throw new ApiError(404, 'Return not found.');

  // Enforce state transitions
  const currentStatus = returnDoc.status as ReturnStatus;
  const allowedNext = RETURN_STATUS_FLOW[currentStatus] ?? [];
  if (!allowedNext.includes(next)) {
    throw new ApiError(400, `Cannot transition return from ${currentStatus} to ${next}. Allowed: ${allowedNext.join(', ')}`);
  }

  // Additional validation: REFUNDED requires a completed refund
  if (next === 'REFUNDED') {
    if (!returnDoc.refund) {
      throw new ApiError(400, 'Cannot mark as REFUNDED without an initiated refund.');
    }
    const refundDoc = await RefundModel.findById(returnDoc.refund);
    if (!refundDoc || refundDoc.status !== 'COMPLETED') {
      throw new ApiError(400, 'Cannot mark as REFUNDED until refund is completed.');
    }
  }

  const updatedReturn = await ReturnModel.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        status: next,
        adminNotes,
        ...(courierName && { courierName }),
        ...(trackingId && { trackingId }),
        ...(trackingUrl && { trackingUrl }),
      },
      $push: { statusHistory: { status: next, timestamp: new Date(), note: adminNotes || `Status changed to ${next}`, updatedBy: req.user!._id } },
    },
    { new: true }
  ).populate('order').populate('user', 'name email');

  if (!updatedReturn) throw new ApiError(404, 'Return not found.');

  // Update order's returnRequest
  const order = await OrderModel.findById(updatedReturn.order._id);
  if (order) {
    const currentReturn = order.returnRequest;
    order.returnRequest = {
      requestedAt: currentReturn?.requestedAt,
      reason: currentReturn?.reason ?? '',
      pickupAddress: currentReturn?.pickupAddress,
      status: next,
      adminNotes,
      ...(courierName && { courierName }),
      ...(trackingId && { trackingId }),
      ...(trackingUrl && { trackingUrl }),
    };
    addStatusHistory(order, order.status, `Return ${next.toLowerCase()}: ${adminNotes || ''}`, String(req.user!._id));
    await order.save();
  }

  // Notify customer
  const user = await UserModel.findById(updatedReturn.user._id).select('email name');
  if (user?.email && order) {
    void sendOrderStatusEmail(user.email, { ...order.toObject(), status: next, shippingAddress: order.shippingAddress });
  }
  const customerName = user?.name ?? 'Customer';
  void notifyOrderStatusChange(updatedReturn.order._id.toString(), `Return ${next}`, customerName);

  res.json({ success: true, data: updatedReturn, message: `Return ${next.toLowerCase()}.` });
}

// POST /api/admin/returns/:id/refund — Admin: initiate refund for a return.
export async function initiateRefund(req: Request, res: Response) {
  const { method, amount, upiId, bankAccount, bankIfsc, bankName, accountHolderName } = req.body as {
    method: 'UPI' | 'BANK';
    amount: number;
    upiId?: string;
    bankAccount?: string;
    bankIfsc?: string;
    bankName?: string;
    accountHolderName?: string;
  };

  if (!['UPI', 'BANK'].includes(method)) throw new ApiError(400, 'Invalid refund method.');
  if (!amount || amount <= 0) throw new ApiError(400, 'Refund amount must be positive.');
  if (method === 'UPI' && !upiId?.trim()) throw new ApiError(400, 'UPI ID is required for UPI refund.');
  if (method === 'BANK' && (!bankAccount?.trim() || !bankIfsc?.trim() || !accountHolderName?.trim())) {
    throw new ApiError(400, 'Bank account, IFSC, and account holder name are required for bank refund.');
  }

  const returnDoc = await ReturnModel.findById(req.params.id).populate('order');
  if (!returnDoc) throw new ApiError(404, 'Return not found.');
  if (returnDoc.status !== 'RECEIVED' && returnDoc.status !== 'APPROVED') {
    throw new ApiError(400, 'Refund can only be initiated after return is received or approved.');
  }
  if (returnDoc.refund) throw new ApiError(400, 'Refund already initiated for this return.');

  // Validate refund amount against order's refundable amount
  const order = await OrderModel.findById(returnDoc.order._id);
  if (!order) throw new ApiError(404, 'Associated order not found.');

  // For online payments, only paid amount can be refunded
  // For COD, refund amount should not exceed order total
  const maxRefundable = order.paymentMethod === 'RAZORPAY' && order.paymentStatus === 'PAID'
    ? order.total
    : order.total;

  if (amount > maxRefundable) {
    throw new ApiError(400, `Refund amount (₹${amount}) cannot exceed order total (₹${maxRefundable}).`);
  }

  const encryption = getEncryptionService();
  const encryptedFields = encryption.encryptFields({
    upiId: upiId ?? '',
    bankAccount: bankAccount ?? '',
    bankIfsc: bankIfsc ?? '',
    bankName: bankName ?? '',
    accountHolderName: accountHolderName ?? '',
  });

  const refundDoc = await RefundModel.create({
    return: returnDoc._id,
    order: returnDoc.order._id,
    user: returnDoc.user,
    amount,
    method,
    ...encryptedFields,
    status: 'PENDING',
  });

  // If order was paid via Razorpay, initiate refund via Razorpay API
  let razorpayRefundId = '';
  if (razorpayEnabled && order.paymentMethod === 'RAZORPAY' && order.paymentStatus === 'PAID' && order.razorpayPaymentId) {
    try {
      const resp = await fetch(`${RAZORPAY_API}/payments/${order.razorpayPaymentId}/refund`, {
        method: 'POST',
        headers: {
          Authorization: razorpayAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: Math.round(amount * 100), // paise
          speed: 'normal',
          notes: { returnId: returnDoc._id.toString(), orderId: order._id.toString() },
        }),
      });

      if (resp.ok) {
        const rzpRefund = (await resp.json()) as { id: string; status: string };
        razorpayRefundId = rzpRefund.id;
        refundDoc.razorpayRefundId = razorpayRefundId;
        // If Razorpay refund is already processed, update status
        if (rzpRefund.status === 'processed') {
          refundDoc.status = 'COMPLETED';
          refundDoc.processedAt = new Date();
        }
        await refundDoc.save();
      } else {
        const detail = await resp.text().catch(() => '');
        console.error(`[refund] Razorpay refund failed: ${resp.status} ${detail}`);
        // Don't fail the whole request; refundDoc stays PENDING for manual processing
      }
    } catch (err) {
      console.error('[refund] Razorpay refund API error:', err);
      // Don't fail the whole request; refundDoc stays PENDING for manual processing
    }
  }

  // Update return with refund reference
  returnDoc.refund = refundDoc._id;
  returnDoc.status = 'REFUND_INITIATED';
  returnDoc.statusHistory.push({ status: 'REFUND_INITIATED', timestamp: new Date(), note: `Refund initiated: ${method} ₹${amount}`, updatedBy: req.user!._id });
  await returnDoc.save();

  // Update order (re-fetch to get latest)
  const updatedOrder = await OrderModel.findById(returnDoc.order._id);
  if (updatedOrder) {
    const currentReturn = updatedOrder.returnRequest;
    updatedOrder.returnRequest = {
      requestedAt: currentReturn?.requestedAt,
      reason: currentReturn?.reason ?? '',
      pickupAddress: currentReturn?.pickupAddress,
      status: 'REFUND_INITIATED',
      adminNotes: currentReturn?.adminNotes ?? '',
    };
    updatedOrder.refund = {
      method,
      amount,
      status: refundDoc.status, // Use the actual status from refundDoc (may be COMPLETED if Razorpay processed it)
      // Encrypted fields are stored but not exposed to client
      upiIdEncrypted: encryptedFields.upiId,
      bankAccountEncrypted: encryptedFields.bankAccount,
      bankIfscEncrypted: encryptedFields.bankIfsc,
      bankNameEncrypted: encryptedFields.bankName,
      accountHolderNameEncrypted: encryptedFields.accountHolderName,
      razorpayRefundId,
    };
    addStatusHistory(updatedOrder, updatedOrder.status, `Refund initiated: ${method} ₹${amount}`, String(req.user!._id));
    await updatedOrder.save();
  }

  // Notify customer
  const user = await UserModel.findById(returnDoc.user).select('email name');
  if (user?.email && updatedOrder) {
    void sendOrderStatusEmail(user.email, { ...updatedOrder.toObject(), status: 'REFUND_INITIATED', shippingAddress: updatedOrder.shippingAddress });
  }
  const customerName = user?.name ?? 'Customer';
  void notifyOrderStatusChange(returnDoc.order._id.toString(), `Refund Initiated: ${method} ₹${amount}`, customerName);

  res.status(201).json({ success: true, data: refundDoc, message: 'Refund initiated.' });
}

// PUT /api/admin/refunds/:id — Admin: mark refund as completed.
export async function completeRefund(req: Request, res: Response) {
  const refundDoc = await RefundModel.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        status: 'COMPLETED',
        processedAt: new Date(),
        processedBy: req.user!._id,
        adminNotes: String(req.body.adminNotes ?? '').slice(0, 500),
      },
    },
    { new: true }
  ).populate('return').populate('order').populate('user', 'name email');

  if (!refundDoc) throw new ApiError(404, 'Refund not found.');

  // Get the order first to know its current status
  const orderDoc = await OrderModel.findById(refundDoc.order._id);
  if (!orderDoc) throw new ApiError(404, 'Order not found.');

  // Update return
  const returnDoc = await ReturnModel.findByIdAndUpdate(
    refundDoc.return._id,
    { $set: { status: 'REFUNDED' }, $push: { statusHistory: { status: 'REFUNDED', timestamp: new Date(), note: 'Refund completed', updatedBy: req.user!._id } } },
    { new: true }
  );

  // Update order - use actual status instead of '$status'
  const order = await OrderModel.findByIdAndUpdate(
    refundDoc.order._id,
    {
      $set: { 'refund.status': 'COMPLETED', 'refund.processedAt': new Date(), 'refund.processedBy': req.user!._id, 'returnRequest.status': 'REFUNDED' },
      $push: { statusHistory: { status: orderDoc.status, timestamp: new Date(), note: 'Refund completed', updatedBy: req.user!._id } },
    },
    { new: true }
  );

  // Notify customer
  const user = await UserModel.findById(refundDoc.user).select('email');
  if (user?.email && order) {
    void sendOrderStatusEmail(user.email, { ...order.toObject(), status: 'REFUNDED', shippingAddress: order.shippingAddress });
  }
  // Get customer name from populated user
  const customerName = (refundDoc.user as any)?.name ?? 'Customer';
  void notifyOrderStatusChange(refundDoc.order._id.toString(), 'Refund Completed', customerName);

  res.json({ success: true, data: refundDoc, message: 'Refund marked as completed.' });
}

// GET /api/admin/refunds — Admin: list all refunds.
export async function listRefunds(req: Request, res: Response) {
  const { page, limit, skip } = getPageParams(req, 20, 100);
  const status = String(req.query.status ?? '').toUpperCase();
  const filter: Record<string, unknown> = {};
  if (status && ['PENDING', 'COMPLETED', 'FAILED'].includes(status)) {
    filter.status = status;
  }

  const [rows, total] = await Promise.all([
    RefundModel.find(filter)
      .populate('order', 'itemsTotal total couponCode')
      .populate('user', 'name email')
      .sort({ createdAt: -1, _id: -1 })
      .skip(req.query.cursor ? 0 : skip)
      .limit(limit + 1),
    RefundModel.countDocuments(filter),
  ]);

  res.json({ success: true, data: cursorPage(rows, total, page, limit, sort, filter) });
}

// GET /api/orders/:id/track — Customer: get tracking info for order.
export async function getOrderTracking(req: Request, res: Response) {
  const order = await OrderModel.findById(req.params.id)
    .select('status courierInfo statusHistory shippingAddress items total createdAt returnRequest refund')
    .populate('user', 'name email');
  if (!order) throw new ApiError(404, 'Order not found.');
  if (String(order.user._id) !== String(req.user!._id) && req.user!.role !== 'ADMIN') {
    throw new ApiError(403, 'Not allowed.');
  }

  // Build tracking URL if tracking ID exists
  // TODO: move courier URL mapping to config/database
  let trackingUrl = order.courierInfo.trackingUrl;
  if (!trackingUrl && order.courierInfo.trackingId) {
    const courier = order.courierInfo.name.toLowerCase();
    if (courier.includes('delhivery')) {
      trackingUrl = `https://track.delhivery.com/api/v1/packages/${encodeURIComponent(order.courierInfo.trackingId)}`;
    } else if (courier.includes('ekart')) {
      trackingUrl = `https://tracking.ekartlogistics.com/${encodeURIComponent(order.courierInfo.trackingId)}`;
    } else if (courier.includes('bluedart')) {
      trackingUrl = `https://www.bluedart.com/waybill/waybillresults.asp?waybill=${encodeURIComponent(order.courierInfo.trackingId)}`;
    }
  }

  res.json({ success: true, data: {
    orderId: order._id,
    status: order.status,
    statusHistory: order.statusHistory,
    courier: order.courierInfo,
    trackingUrl,
    shippingAddress: order.shippingAddress,
    items: order.items,
    total: order.total,
    createdAt: order.createdAt,
    returnRequest: order.returnRequest,
    refund: order.refund,
  } });
}

// GET /api/orders/:id/invoice — Generate and stream PDF invoice.
export async function generateInvoice(req: Request, res: Response) {
  const order = await OrderModel.findById(req.params.id).populate('user', 'name email');
  if (!order) throw new ApiError(404, 'Order not found.');
  if (String(order.user._id) !== String(req.user!._id) && req.user!.role !== 'ADMIN') throw new ApiError(403, 'Not allowed.');

  const user = order.user as any;
  const brand = (await import('../config/env.js')).env; // Access brand info from env if needed

  // Create PDF document
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const filename = `invoice-${order._id.toString().slice(-6).toUpperCase()}.pdf`;

  // Set response headers for PDF download
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // Pipe PDF to response
  doc.pipe(res);

  // --- Header ---
  doc.fontSize(24).font('Helvetica-Bold').text('INVOICE', { align: 'center' });
  doc.moveDown(0.5);

  // Brand info
  doc.fontSize(10).font('Helvetica').text('Ramachandra Traders', { align: 'center' });
  doc.text('GSTIN: XXXXXXXXXXXXXXX', { align: 'center' });
  doc.text('Email: support@ramachandratraders.com', { align: 'center' });
  doc.text('Phone: +91-XXXXXXXXXX', { align: 'center' });
  doc.moveDown(1);

  // Invoice details table
  const startX = 50;
  let y = doc.y;

  // Invoice info
  doc.fontSize(10).font('Helvetica-Bold').text('Invoice Details:', startX, y);
  doc.font('Helvetica').text(`Invoice #: ${order._id.toString().slice(-6).toUpperCase()}`, startX + 200, y);
  y += 15;
  doc.font('Helvetica-Bold').text('Date:', startX, y);
  doc.font('Helvetica').text(new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }), startX + 200, y);
  y += 15;
  doc.font('Helvetica-Bold').text('Order ID:', startX, y);
  doc.font('Helvetica').text(order._id.toString(), startX + 200, y);
  y += 15;
  doc.font('Helvetica-Bold').text('Payment Method:', startX, y);
  doc.font('Helvetica').text(order.paymentMethod === 'COD' ? 'Cash on Delivery' : 'Online Payment (Razorpay)', startX + 200, y);
  y += 15;
  doc.font('Helvetica-Bold').text('Payment Status:', startX, y);
  doc.font('Helvetica').text(order.paymentStatus, startX + 200, y);
  y += 15;
  doc.font('Helvetica-Bold').text('Order Status:', startX, y);
  doc.font('Helvetica').text(order.status, startX + 200, y);

  doc.y = y + 20;

  // Bill To
  doc.fontSize(12).font('Helvetica-Bold').text('Bill To:', startX);
  doc.fontSize(10).font('Helvetica');
  doc.text(user?.name ?? 'Customer', startX, doc.y + 5);
  doc.text(order.shippingAddress.fullName, startX, doc.y + 15);
  doc.text(order.shippingAddress.line1, startX, doc.y + 15);
  if (order.shippingAddress.line2) doc.text(order.shippingAddress.line2, startX, doc.y + 15);
  doc.text(`${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.pincode}`, startX, doc.y + 15);
  doc.text(`Phone: ${order.shippingAddress.phone}`, startX, doc.y + 15);
  if (user?.email) doc.text(`Email: ${user.email}`, startX, doc.y + 15);

  doc.moveDown(1);

  // Items table header
  const tableTop = doc.y;
  const col1 = startX; // Item
  const col2 = 280;    // Qty
  const col3 = 330;    // Unit Price
  const col4 = 420;    // Total

  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('Item', col1, tableTop);
  doc.text('Qty', col2, tableTop);
  doc.text('Unit Price', col3, tableTop);
  doc.text('Total', col4, tableTop);

  // Draw header line
  doc.moveTo(startX, tableTop + 15).lineTo(500, tableTop + 15).stroke();

  let rowY = tableTop + 20;
  doc.font('Helvetica');

  for (const item of order.items) {
    // Check if we need a new page
    if (rowY > 700) {
      doc.addPage();
      rowY = 50;
    }

    const title = item.title.length > 35 ? item.title.substring(0, 32) + '...' : item.title;
    doc.text(title, col1, rowY, { width: 170 });
    doc.text(item.quantity.toString(), col2, rowY);
    doc.text(`₹${item.unitPrice.toLocaleString('en-IN')}`, col3, rowY);
    doc.text(`₹${item.lineTotal.toLocaleString('en-IN')}`, col4, rowY);
    rowY += 20;
  }

  // Draw line after items
  doc.moveTo(startX, rowY).lineTo(500, rowY).stroke();
  rowY += 10;

  // Totals
  const totalsX = 300;
  doc.fontSize(10).font('Helvetica');
  doc.text('Items Total:', totalsX, rowY);
  doc.text(`₹${order.itemsTotal.toLocaleString('en-IN')}`, col4, rowY);
  rowY += 18;

  doc.text('Delivery Fee:', totalsX, rowY);
  doc.text(order.deliveryFee === 0 ? 'FREE' : `₹${order.deliveryFee.toLocaleString('en-IN')}`, col4, rowY);
  rowY += 18;

  if (order.heavyProductFee && order.heavyProductFee > 0) {
    doc.text('Heavy Product Delivery:', totalsX, rowY);
    doc.text(`₹${order.heavyProductFee.toLocaleString('en-IN')}`, col4, rowY);
    rowY += 18;
  }

  if (order.discount && order.discount > 0) {
    doc.font('Helvetica').text(`Discount${order.couponCode ? ` (${order.couponCode})` : ''}:`, totalsX, rowY);
    doc.font('Helvetica').text(`-₹${order.discount.toLocaleString('en-IN')}`, col4, rowY);
    rowY += 18;
  }

  doc.moveTo(startX, rowY).lineTo(500, rowY).stroke();
  rowY += 10;

  doc.fontSize(12).font('Helvetica-Bold');
  doc.text('Grand Total:', totalsX, rowY);
  doc.text(`₹${order.total.toLocaleString('en-IN')}`, col4, rowY);

  doc.moveDown(2);

  // Footer notes
  doc.fontSize(9).font('Helvetica');
  doc.text('Notes:', startX);
  doc.text('1. This is a computer-generated invoice and does not require a signature.', startX + 10, doc.y + 5);
  doc.text('2. For COD orders, payment is collected upon delivery.', startX + 10, doc.y + 15);
  doc.text('3. For online payments, payment is processed via Razorpay.', startX + 10, doc.y + 15);
  doc.text('4. Returns must be requested within 7 days of delivery.', startX + 10, doc.y + 15);
  doc.text('5. For any queries, contact support@ramachandratraders.com', startX + 10, doc.y + 15);

  doc.moveDown(1);
  doc.fontSize(9).font('Helvetica-Oblique').text('Thank you for shopping with Ramachandra Traders!', { align: 'center' });

  // Finalize PDF
  doc.end();
}

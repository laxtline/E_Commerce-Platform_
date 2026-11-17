import type { Request, Response } from "express";
import crypto from "node:crypto";
import { OrderModel } from "../models/Order.js";
import { ProductModel } from "../models/Product.js";
import { WebhookEventModel } from "../models/WebhookEvent.js";
import { ApiError } from "../utils/ApiError.js";
import { env, razorpayEnabled } from "../config/env.js";
import mongoose from "mongoose";

const RAZORPAY_API = "https://api.razorpay.com/v1";

/** Basic-auth header for Razorpay's REST API (key_id:key_secret). */
function razorpayAuthHeader(): string {
  const token = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64");
  return `Basic ${token}`;
}

/**
 * GET /api/payments/config — public.
 * Tells the storefront whether online payment is available and the public key id.
 */
export async function getPaymentConfig(_req: Request, res: Response) {
  res.json({
    success: true,
    data: {
      razorpayEnabled,
      razorpayKeyId: razorpayEnabled ? env.razorpayKeyId : "",
    },
  });
}

/**
 * POST /api/payments/razorpay/order — auth.
 * Body: { orderId }. Creates a Razorpay order for one of our PENDING orders
 * and returns the details the client needs to open Razorpay Checkout.
 * Reuses existing razorpayOrderId if order is still PENDING and has a valid Razorpay order ID.
 */
export async function createRazorpayOrder(req: Request, res: Response) {
  if (!razorpayEnabled) throw new ApiError(503, "Online payment is not available right now.");

  const orderId = String(req.body?.orderId ?? "");
  const order = await OrderModel.findById(orderId);
  if (!order) throw new ApiError(404, "Order not found.");
  if (order.user.toString() !== req.user!._id.toString()) throw new ApiError(403, "Not allowed.");
  if (order.paymentMethod !== "RAZORPAY") throw new ApiError(400, "This order is not an online-payment order.");
  if (order.paymentStatus === "PAID") throw new ApiError(400, "This order is already paid.");
  if (order.status === "CANCELLED") throw new ApiError(400, "This order was cancelled and can no longer be paid.");

  const amount = Math.round(order.total * 100); // paise

  // Reuse existing Razorpay order ID if order is still PENDING and has one
  // This prevents creating multiple Razorpay orders for the same order on retry
  if (order.razorpayOrderId && order.paymentStatus === "PENDING") {
    // Verify the Razorpay order still exists and is not paid/expired
    try {
      const verifyResp = await fetch(`${RAZORPAY_API}/orders/${order.razorpayOrderId}`, {
        method: "GET",
        headers: { Authorization: razorpayAuthHeader() },
      });
      if (verifyResp.ok) {
        const existingOrder = await verifyResp.json() as { id: string; amount: number; currency: string; status: string };
        // Only reuse if Razorpay order is still 'created' (not paid/attempted/expired)
        if (existingOrder.status === "created") {
          res.json({
            success: true,
            data: {
              keyId: env.razorpayKeyId,
              razorpayOrderId: existingOrder.id,
              amount: existingOrder.amount,
              currency: existingOrder.currency,
              orderId: order.id,
            },
          });
          return;
        }
      }
    } catch {
      // If verification fails, fall through to create new order
    }
  }

  const resp = await fetch(`${RAZORPAY_API}/orders`, {
    method: "POST",
    headers: {
      Authorization: razorpayAuthHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: "INR",
      receipt: order.id,
      notes: { orderId: order.id },
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new ApiError(502, `Could not initiate payment. ${detail.slice(0, 200)}`);
  }

  const rzp = (await resp.json()) as { id: string; amount: number; currency: string };
  order.razorpayOrderId = rzp.id;
  await order.save();

  res.json({
    success: true,
    data: {
      keyId: env.razorpayKeyId,
      razorpayOrderId: rzp.id,
      amount: rzp.amount,
      currency: rzp.currency,
      orderId: order.id,
    },
  });
}

/**
 * POST /api/payments/razorpay/verify — auth.
 * Body: { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature }.
 * Verifies the HMAC signature and marks the order PAID on success.
 * Also confirms stock deduction (moves from reservedStock to actual stock).
 */
export async function verifyRazorpayPayment(req: Request, res: Response) {
  if (!razorpayEnabled) throw new ApiError(503, "Online payment is not available right now.");

  const { orderId, razorpayPaymentId, razorpayOrderId, razorpaySignature } = req.body ?? {};
  if (!orderId || !razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
    throw new ApiError(400, "Missing payment verification fields.");
  }

  const order = await OrderModel.findById(orderId);
  if (!order) throw new ApiError(404, "Order not found.");
  if (order.user.toString() !== req.user!._id.toString()) throw new ApiError(403, "Not allowed.");
  if (order.status === "CANCELLED") throw new ApiError(400, "This order was cancelled and can no longer be paid.");
  if (order.razorpayOrderId !== razorpayOrderId) throw new ApiError(400, "Payment order mismatch.");

  // Razorpay signature = HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret).
  const expected = crypto
    .createHmac("sha256", env.razorpayKeySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  const valid =
    expected.length === String(razorpaySignature).length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(razorpaySignature)));

  if (!valid) {
    order.paymentStatus = "FAILED";
    // Release reserved stock on verification failure
    await mongoose.connection.transaction(async (session) => {
      await order.save({ session });
      for (const line of order.items) {
        if (line.product) {
          await ProductModel.updateOne(
            { _id: line.product },
            { $inc: { reservedStock: -line.quantity } },
            { session }
          );
        }
      }
    });
    throw new ApiError(400, "Payment verification failed. If money was deducted, it will be refunded.");
  }

  // Idempotency: already paid
  if (order.paymentStatus === "PAID" && order.razorpayPaymentId === razorpayPaymentId) {
    res.json({ success: true, data: order, message: "Payment already verified." });
    return;
  }

  // Verify amount matches
  const expectedAmount = Math.round(order.total * 100);
  // Note: We don't have the payment amount here, but we trust the signature verification

  // Mark as paid and confirm stock deduction within transaction
  await mongoose.connection.transaction(async (session) => {
    order.paymentStatus = "PAID";
    order.razorpayPaymentId = razorpayPaymentId;
    await order.save({ session });

    // Confirm stock deduction: move from reservedStock to actual stock deduction
    for (const line of order.items) {
      if (line.product) {
        await ProductModel.updateOne(
          { _id: line.product },
          { $inc: { reservedStock: -line.quantity, stock: -line.quantity } },
          { session }
        );
      }
    }
  });

  res.json({ success: true, data: order, message: "Payment successful." });
}

/**
 * POST /api/payments/razorpay/webhook — public (Razorpay callback).
 * Handles Razorpay webhook events for payment verification and order updates.
 * Does NOT require auth — verified via webhook signature.
 */
export async function razorpayWebhook(req: Request, res: Response) {
  if (!razorpayEnabled) {
    return res.status(503).json({ success: false, message: "Online payment is not available." });
  }

  // Verify webhook signature
  const webhookSecret = env.razorpayWebhookSecret;
  if (!webhookSecret) {
    console.error("[webhook] Razorpay webhook secret not configured");
    return res.status(500).json({ success: false, message: "Webhook not configured." });
  }

  const signature = req.headers["x-razorpay-signature"] as string;
  if (!signature) {
    return res.status(400).json({ success: false, message: "Missing webhook signature." });
  }

  // Raw body is already a Buffer (from express.raw middleware)
  // Use it directly for signature verification to avoid whitespace issues
  const rawBody = req.body as Buffer;
  if (!rawBody || rawBody.length === 0) {
    return res.status(400).json({ success: false, message: "Empty webhook payload." });
  }

  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  // Validate signature encoding and length before constant-time comparison
  if (signature.length !== expectedSignature.length || !/^[a-f0-9]+$/i.test(signature)) {
    console.error("[webhook] Invalid webhook signature format");
    return res.status(400).json({ success: false, message: "Invalid signature format." });
  }

  const valid = crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
  if (!valid) {
    console.error("[webhook] Invalid webhook signature");
    return res.status(400).json({ success: false, message: "Invalid signature." });
  }

  // Parse the JSON payload after successful verification
  let event: any;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    console.error("[webhook] Failed to parse webhook payload:", e);
    return res.status(400).json({ success: false, message: "Invalid JSON payload." });
  }

  const eventId = event.id; // Razorpay event ID for idempotency

  // Idempotency: check if we've already processed this event (using database)
  if (eventId) {
    const existing = await WebhookEventModel.findOne({ eventId }).lean();
    if (existing) {
      console.log(`[webhook] Duplicate event ${eventId} ignored (already processed)`);
      return res.json({ success: true, message: "Event already processed." });
    }
  }

  try {
    let result = 'success';
    let error = '';

    switch (event.event) {
      case "payment.captured":
        await handlePaymentCaptured(event.payload.payment.entity);
        break;
      case "payment.failed":
        await handlePaymentFailed(event.payload.payment.entity);
        break;
      case "order.paid":
        await handleOrderPaid(event.payload.order.entity);
        break;
      default:
        console.log(`[webhook] Unhandled event type: ${event.event}`);
    }

    // Store event in database for idempotency (with TTL index for auto-cleanup)
    if (eventId) {
      await WebhookEventModel.create({
        eventId,
        eventType: event.event,
        payload: event,
        result,
        error,
      });
    }

    res.json({ success: true, message: "Webhook processed." });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error("[webhook] Error processing webhook:", error);

    // Store failed event for debugging
    if (eventId) {
      await WebhookEventModel.create({
        eventId,
        eventType: event.event,
        payload: event,
        result: 'failed',
        error: errorMsg,
      });
    }

    res.status(500).json({ success: false, message: "Webhook processing failed." });
  }
}

/** Handle payment.captured event — mark order as PAID and confirm stock deduction. */
async function handlePaymentCaptured(payment: any) {
  const orderId = payment.notes?.orderId;
  if (!orderId) {
    console.warn("[webhook] No orderId in payment notes");
    return;
  }

  const order = await OrderModel.findById(orderId);
  if (!order) {
    console.warn(`[webhook] Order ${orderId} not found`);
    return;
  }

  // Idempotency: already paid
  if (order.paymentStatus === "PAID" && order.razorpayPaymentId === payment.id) {
    console.log(`[webhook] Order ${orderId} already marked paid for payment ${payment.id}`);
    return;
  }

  // CRITICAL: Prevent marking cancelled orders as PAID (race condition)
  // If order was cancelled, reserved stock was already released - don't mark as paid
  if (order.status === "CANCELLED") {
    console.warn(`[webhook] Order ${orderId} is CANCELLED, not marking as PAID. Payment ${payment.id} requires manual refund.`);
    // Log for manual reconciliation - do NOT change payment status
    return;
  }

  // Verify amount matches (in paise)
  const expectedAmount = Math.round(order.total * 100);
  if (payment.amount !== expectedAmount) {
    console.error(`[webhook] Amount mismatch: expected ${expectedAmount}, got ${payment.amount}`);
    // Don't auto-mark as paid; flag for manual review
    order.paymentStatus = "FAILED";
    await order.save();
    return;
  }

  // Verify currency
  if (payment.currency !== "INR") {
    console.error(`[webhook] Currency mismatch: expected INR, got ${payment.currency}`);
    order.paymentStatus = "FAILED";
    await order.save();
    return;
  }

  // Mark as paid and confirm stock deduction (move from reservedStock to actual stock deduction)
  await mongoose.connection.transaction(async (session) => {
    order.paymentStatus = "PAID";
    order.razorpayPaymentId = payment.id;
    order.razorpayOrderId = payment.order_id;
    await order.save({ session });

    // Confirm stock deduction: move from reservedStock to actual stock deduction
    // For each item, decrement reservedStock and decrement actual stock
    for (const line of order.items) {
      if (line.product) {
        await ProductModel.updateOne(
          { _id: line.product },
          { $inc: { reservedStock: -line.quantity, stock: -line.quantity } },
          { session }
        );
      }
    }
  });

  console.log(`[webhook] Order ${orderId} marked PAID via webhook (payment ${payment.id}), stock confirmed`);
}

/** Handle payment.failed event — mark order payment as FAILED and release reserved stock. */
async function handlePaymentFailed(payment: any) {
  const orderId = payment.notes?.orderId;
  if (!orderId) return;

  const order = await OrderModel.findById(orderId);
  if (!order) return;

  if (order.paymentStatus === "PENDING") {
    await mongoose.connection.transaction(async (session) => {
      order.paymentStatus = "FAILED";
      await order.save({ session });

      // Release reserved stock for failed payments
      for (const line of order.items) {
        if (line.product) {
          await ProductModel.updateOne(
            { _id: line.product },
            { $inc: { reservedStock: -line.quantity } },
            { session }
          );
        }
      }
    });
    console.log(`[webhook] Order ${orderId} marked FAILED via webhook (payment ${payment.id}), reserved stock released`);
  }
}

/** Handle order.paid event — fallback for when payment.captured isn't received. */
async function handleOrderPaid(orderEntity: any) {
  const orderId = orderEntity.notes?.orderId;
  if (!orderId) return;

  const order = await OrderModel.findById(orderId);
  if (!order) return;

  // Only mark paid if we have a payment ID and it's not already paid
  if (order.paymentStatus !== "PAID" && orderEntity.amount_paid > 0) {
    const expectedAmount = Math.round(order.total * 100);
    if (orderEntity.amount_paid >= expectedAmount) {
      await mongoose.connection.transaction(async (session) => {
        order.paymentStatus = "PAID";
        order.razorpayOrderId = orderEntity.id;
        await order.save({ session });

        // Confirm stock deduction: move from reservedStock to actual stock deduction
        for (const line of order.items) {
          if (line.product) {
            await ProductModel.updateOne(
              { _id: line.product },
              { $inc: { reservedStock: -line.quantity, stock: -line.quantity } },
              { session }
            );
          }
        }
      });
      console.log(`[webhook] Order ${orderId} marked PAID via order.paid event, stock confirmed`);
    }
  }
}

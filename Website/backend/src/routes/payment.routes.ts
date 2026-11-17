import { Router } from "express";
import {
  getPaymentConfig,
  createRazorpayOrder,
  verifyRazorpayPayment,
  razorpayWebhook,
} from "../controllers/paymentController.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../utils/validate.js";
import { razorpayOrderSchema, razorpayVerifySchema } from "../validation/schemas.js";

const router = Router();

router.get("/config", asyncHandler(getPaymentConfig));
router.post("/razorpay/order", requireAuth, validateBody(razorpayOrderSchema), asyncHandler(createRazorpayOrder));
router.post("/razorpay/verify", requireAuth, validateBody(razorpayVerifySchema), asyncHandler(verifyRazorpayPayment));
// Webhook endpoint - NO auth required, verified via signature
router.post("/razorpay/webhook", asyncHandler(razorpayWebhook));

export default router;

import { Router } from "express";
import { calculateDeliveryFeeHandler } from "../controllers/deliveryConfigController.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

// Public route for calculating delivery fee at checkout
router.post("/calculate", asyncHandler(calculateDeliveryFeeHandler));

export default router;
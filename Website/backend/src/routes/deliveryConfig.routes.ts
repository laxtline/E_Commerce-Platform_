import { Router } from "express";
import { getDeliveryConfigHandler, updateDeliveryConfigHandler, calculateDeliveryFeeHandler } from "../controllers/deliveryConfigController.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = Router();

// Public route for calculating delivery fee at checkout
router.post("/calculate", asyncHandler(calculateDeliveryFeeHandler));

// All routes below require admin authentication
router.use(requireAuth, requireAdmin);

router.get("/", asyncHandler(getDeliveryConfigHandler));
router.put("/", asyncHandler(updateDeliveryConfigHandler));

export default router;
import type { Request, Response } from "express";
import { getFullDeliveryConfig, updateDeliveryConfig, calculateDeliveryFee, calculateHeavyProductFee } from "../services/delivery.js";

/** GET /api/admin/delivery-config — admin only. Returns delivery configuration. */
export async function getDeliveryConfigHandler(_req: Request, res: Response) {
  const config = await getFullDeliveryConfig();
  res.json({ success: true, data: config });
}

/** PUT /api/admin/delivery-config — admin only. Updates delivery configuration. */
export async function updateDeliveryConfigHandler(req: Request, res: Response) {
  const data = req.body as {
    baseFee?: number;
    freeOver?: number;
    noCodPincodes?: string[];
    serviceablePincodes?: string[];
    pincodeRates?: Record<string, number>;
    heavyProductThresholdKg?: number;
    heavyProductFeePerKg?: number;
    heavyProductBaseFee?: number;
  };

  // Validate numeric fields
  if (data.baseFee !== undefined && (typeof data.baseFee !== 'number' || data.baseFee < 0)) {
    return res.status(400).json({ success: false, message: 'baseFee must be a non-negative number.' });
  }
  if (data.freeOver !== undefined && (typeof data.freeOver !== 'number' || data.freeOver < 0)) {
    return res.status(400).json({ success: false, message: 'freeOver must be a non-negative number.' });
  }
  if (data.heavyProductThresholdKg !== undefined && (typeof data.heavyProductThresholdKg !== 'number' || data.heavyProductThresholdKg < 0)) {
    return res.status(400).json({ success: false, message: 'heavyProductThresholdKg must be a non-negative number.' });
  }
  if (data.heavyProductFeePerKg !== undefined && (typeof data.heavyProductFeePerKg !== 'number' || data.heavyProductFeePerKg < 0)) {
    return res.status(400).json({ success: false, message: 'heavyProductFeePerKg must be a non-negative number.' });
  }
  if (data.heavyProductBaseFee !== undefined && (typeof data.heavyProductBaseFee !== 'number' || data.heavyProductBaseFee < 0)) {
    return res.status(400).json({ success: false, message: 'heavyProductBaseFee must be a non-negative number.' });
  }

  // Validate arrays
  if (data.noCodPincodes !== undefined && !Array.isArray(data.noCodPincodes)) {
    return res.status(400).json({ success: false, message: 'noCodPincodes must be an array.' });
  }
  if (data.serviceablePincodes !== undefined && !Array.isArray(data.serviceablePincodes)) {
    return res.status(400).json({ success: false, message: 'serviceablePincodes must be an array.' });
  }
  if (data.pincodeRates !== undefined && (typeof data.pincodeRates !== 'object' || data.pincodeRates === null)) {
    return res.status(400).json({ success: false, message: 'pincodeRates must be an object.' });
  }

  const config = await updateDeliveryConfig(data);
  res.json({ success: true, data: config, message: "Delivery configuration updated." });
}

/** POST /api/delivery/calculate — public. Calculate delivery fee for checkout. */
export async function calculateDeliveryFeeHandler(req: Request, res: Response) {
  const { itemsTotal, pincode, items } = req.body as {
    itemsTotal: number;
    pincode: string;
    items?: Array<{ weight: number; quantity: number }>;
  };

  if (!itemsTotal || !pincode) {
    return res.status(400).json({ success: false, message: 'itemsTotal and pincode are required.' });
  }

  try {
    // Calculate regular delivery fee
    const deliveryResult = await calculateDeliveryFee(itemsTotal, pincode);

    // Calculate heavy product fee if items provided
    let heavyProductResult = { isHeavy: false, additionalFee: 0, breakdown: '' };
    if (items && items.length > 0) {
      heavyProductResult = await calculateHeavyProductFee(items);
    }

    const totalDeliveryFee = deliveryResult.fee + heavyProductResult.additionalFee;

    res.json({
      success: true,
      data: {
        deliveryFee: deliveryResult.fee,
        heavyProductFee: heavyProductResult.additionalFee,
        heavyProductBreakdown: heavyProductResult.breakdown,
        totalDeliveryFee,
        isFree: deliveryResult.isFree,
        codAvailable: deliveryResult.codAvailable,
        serviceable: deliveryResult.serviceable,
      }
    });
  } catch (err) {
    console.error('[delivery] calculateDeliveryFee error:', err);
    res.status(500).json({ success: false, message: 'Failed to calculate delivery fee.' });
  }
}
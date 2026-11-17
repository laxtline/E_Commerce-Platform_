import { DeliveryConfigModel, getDeliveryConfig, IDeliveryConfig } from '../models/DeliveryConfig.js';
import { calculateDeliveryFee as sharedCalculateDeliveryFee, DeliveryConfig as SharedDeliveryConfig } from '@shared/pricing.js';

/**
 * Get the delivery configuration from database.
 * Falls back to defaults if not found.
 */
export async function getDeliveryConfigService(): Promise<SharedDeliveryConfig> {
  const config = await getDeliveryConfig();
  return {
    baseFee: config.baseFee,
    freeOver: config.freeOver,
    noCodPincodes: config.noCodPincodes,
    serviceablePincodes: config.serviceablePincodes,
    pincodeRates: config.pincodeRates,
  };
}

/**
 * Calculate delivery fee using database config.
 * This is a wrapper around the shared function that fetches config from DB.
 */
export async function calculateDeliveryFee(itemsTotal: number, pincode: string) {
  const config = await getDeliveryConfigService();
  return sharedCalculateDeliveryFee(itemsTotal, pincode, config);
}

/**
 * Calculate heavy product delivery fee.
 * Returns the additional fee for heavy products in the cart.
 */
export async function calculateHeavyProductFee(
  items: Array<{ weight: number; quantity: number }>
): Promise<{ isHeavy: boolean; additionalFee: number; breakdown: string }> {
  const config = await getDeliveryConfig();
  const threshold = config.heavyProductThresholdKg;
  const feePerKg = config.heavyProductFeePerKg;
  const baseFee = config.heavyProductBaseFee;

  let totalHeavyWeight = 0;
  let heavyItemsCount = 0;

  for (const item of items) {
    const itemTotalWeight = item.weight * item.quantity;
    if (item.weight >= threshold) {
      totalHeavyWeight += itemTotalWeight;
      heavyItemsCount += item.quantity;
    }
  }

  if (totalHeavyWeight === 0) {
    return { isHeavy: false, additionalFee: 0, breakdown: '' };
  }

  // Calculate additional fee: base fee + (weight - threshold) * feePerKg
  // But we apply it per heavy item
  let additionalFee = 0;
  for (const item of items) {
    if (item.weight >= threshold) {
      const excessWeight = (item.weight - threshold) * item.quantity;
      additionalFee += baseFee + excessWeight * feePerKg;
    }
  }

  const breakdown = `Heavy items: ${heavyItemsCount}, Total weight: ${totalHeavyWeight.toFixed(1)}kg, Base fee: ₹${baseFee}/item, Rate: ₹${feePerKg}/kg above ${threshold}kg`;

  return { isHeavy: true, additionalFee: Math.round(additionalFee), breakdown };
}

/**
 * Update delivery configuration (admin only).
 */
export async function updateDeliveryConfig(data: Partial<SharedDeliveryConfig> & { heavyProductThresholdKg?: number; heavyProductFeePerKg?: number; heavyProductBaseFee?: number }) {
  // Find existing config or create new one
  let config = await DeliveryConfigModel.findOne();
  if (!config) {
    config = new DeliveryConfigModel(data);
  } else {
    Object.assign(config, data);
  }
  await config.save();
  return config;
}

/**
 * Get full delivery config including heavy product settings.
 */
export async function getFullDeliveryConfig(): Promise<IDeliveryConfig> {
  const config = await getDeliveryConfig();
  return config;
}
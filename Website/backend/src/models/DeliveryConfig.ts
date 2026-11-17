import mongoose, { Schema, Document } from 'mongoose';

export interface IDeliveryConfig extends Document {
  baseFee: number;
  freeOver: number;
  noCodPincodes: string[];
  serviceablePincodes: string[];
  pincodeRates: Record<string, number>;
  heavyProductThresholdKg: number;
  heavyProductFeePerKg: number;
  heavyProductBaseFee: number;
  updatedAt: Date;
  createdAt: Date;
}

const DeliveryConfigSchema = new Schema<IDeliveryConfig>(
  {
    baseFee: { type: Number, required: true, default: 49 },
    freeOver: { type: Number, required: true, default: 5000 },
    noCodPincodes: { type: [String], default: [] },
    serviceablePincodes: { type: [String], default: [] },
    pincodeRates: { type: Schema.Types.Mixed, default: {} },
    heavyProductThresholdKg: { type: Number, default: 5 },
    heavyProductFeePerKg: { type: Number, default: 10 },
    heavyProductBaseFee: { type: Number, default: 99 },
  },
  { timestamps: true }
);

// Ensure only one config document exists (singleton pattern)
DeliveryConfigSchema.index({}, { unique: true });

export const DeliveryConfigModel = mongoose.model<IDeliveryConfig>('DeliveryConfig', DeliveryConfigSchema);

// Helper to get the singleton config
export async function getDeliveryConfig(): Promise<IDeliveryConfig> {
  let config = await DeliveryConfigModel.findOne().exec();
  if (!config) {
    config = await DeliveryConfigModel.create({});
  }
  return config;
}
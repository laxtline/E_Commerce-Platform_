import { Schema, model, type InferSchemaType } from 'mongoose';

const webhookEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true, index: true },
    eventType: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    processedAt: { type: Date, default: Date.now },
    result: { type: String, enum: ['success', 'failed'], default: 'success' },
    error: { type: String, default: '' },
  },
  { timestamps: true }
);

// TTL index to auto-expire after 30 days
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export type WebhookEventDoc = InferSchemaType<typeof webhookEventSchema>;

export const WebhookEventModel = model('WebhookEvent', webhookEventSchema);
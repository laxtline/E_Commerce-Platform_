"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

export function DeliveryManagementPage() {
  return (
    <ProtectedRoute adminOnly>
      <DeliveryManagement />
    </ProtectedRoute>
  );
}

function DeliveryManagement() {
  const { toast } = useToast();
  const [config, setConfig] = useState<DeliveryConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<DeliveryConfig>("/api/admin/delivery-config");
      setConfig(data);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load delivery config", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!config) return;

    setSaving(true);
    try {
      const updated = await apiFetch<DeliveryConfig>("/api/admin/delivery-config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setConfig(updated);
      toast("Delivery configuration saved!", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save delivery config", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (field: keyof DeliveryConfig, value: string | number | string[] | Record<string, number>) => {
    setConfig((prev) => (prev ? { ...prev, [field]: value } : null));
  };

  const handleArrayChange = (field: "noCodPincodes" | "serviceablePincodes", value: string) => {
    setConfig((prev) => {
      if (!prev) return null;
      const arr = value.split(",").map((v) => v.trim()).filter(Boolean);
      return { ...prev, [field]: arr };
    });
  };

  const handlePincodeRatesChange = (value: string) => {
    try {
      const rates = value ? JSON.parse(value) : {};
      if (typeof rates === 'object' && rates !== null) {
        setConfig((prev) => (prev ? { ...prev, pincodeRates: rates } : null));
      }
    } catch {
      // Invalid JSON, ignore
    }
  };

  if (loading) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!config) {
    return <div className="text-red-600">Failed to load delivery configuration.</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">Delivery Configuration</h1>
      <p className="text-slate-600">
        Manage delivery fees, COD availability, and serviceable areas. Changes apply immediately.
      </p>

      <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
        {/* Base Settings */}
        <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-card">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Base Delivery Settings</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="baseFee" className="block text-sm font-medium text-slate-700 mb-1">
                Base Delivery Fee (₹)
              </label>
              <Input
                id="baseFee"
                type="number"
                value={config.baseFee}
                onChange={(e) => handleChange("baseFee", parseInt(e.target.value) || 0)}
                min="0"
                className="w-full"
              />
            </div>
            <div>
              <label htmlFor="freeOver" className="block text-sm font-medium text-slate-700 mb-1">
                Free Delivery Over (₹)
              </label>
              <Input
                id="freeOver"
                type="number"
                value={config.freeOver}
                onChange={(e) => handleChange("freeOver", parseInt(e.target.value) || 0)}
                min="0"
                className="w-full"
              />
            </div>
          </div>
        </div>

        {/* COD & Serviceability */}
        <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-card">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">COD & Serviceability</h2>
          <p className="text-sm text-slate-500 mb-4">
            Enter PIN code prefixes (e.g., "110" for Delhi, "400" for Mumbai). Comma-separated.
          </p>
          <div className="space-y-4">
            <div>
              <label htmlFor="noCodPincodes" className="block text-sm font-medium text-slate-700 mb-1">
                COD Not Available (PIN prefixes)
              </label>
              <Input
                id="noCodPincodes"
                type="text"
                value={config.noCodPincodes.join(", ")}
                onChange={(e) => handleArrayChange("noCodPincodes", e.target.value)}
                placeholder="e.g., 110, 400, 560"
                className="w-full max-w-md"
              />
              <p className="mt-1 text-xs text-slate-500">Customers in these areas cannot select Cash on Delivery.</p>
            </div>
            <div>
              <label htmlFor="serviceablePincodes" className="block text-sm font-medium text-slate-700 mb-1">
                Serviceable PIN Prefixes (empty = all)
              </label>
              <Input
                id="serviceablePincodes"
                type="text"
                value={config.serviceablePincodes.join(", ")}
                onChange={(e) => handleArrayChange("serviceablePincodes", e.target.value)}
                placeholder="e.g., 110, 400, 560"
                className="w-full max-w-md"
              />
              <p className="mt-1 text-xs text-slate-500">Only these PIN prefixes can place orders. Leave empty to allow all.</p>
            </div>
          </div>
        </div>

        {/* Per-PIN Code Rates */}
        <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-card">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Per-PIN Code Rate Overrides</h2>
          <p className="text-sm text-slate-500 mb-4">
            JSON object mapping PIN code prefixes to delivery fees. Example:{" "}
            <code className="bg-slate-100 px-1 rounded">{'{"110": 30, "400": 40}'}</code>
          </p>
          <div>
            <label htmlFor="pincodeRates" className="block text-sm font-medium text-slate-700 mb-1">
              PIN Code Rates (JSON)
            </label>
            <Input
              id="pincodeRates"
              type="text"
              value={JSON.stringify(config.pincodeRates, null, 2)}
              onChange={(e) => handlePincodeRatesChange(e.target.value)}
              placeholder='{"110": 30, "400": 40}'
              className="w-full max-w-md font-mono text-sm"
            />
            <p className="mt-1 text-xs text-slate-500">Leave empty or {} to use base fee for all areas.</p>
          </div>
        </div>

        {/* Heavy Product Delivery */}
        <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-card">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Heavy Product Delivery</h2>
          <p className="text-sm text-slate-500 mb-4">
            Additional charges for heavy products (based on product weight). These settings work with the "Heavy Product Quote" feature.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="heavyProductThresholdKg" className="block text-sm font-medium text-slate-700 mb-1">
                Threshold (kg)
              </label>
              <Input
                id="heavyProductThresholdKg"
                type="number"
                value={config.heavyProductThresholdKg}
                onChange={(e) => handleChange("heavyProductThresholdKg", parseFloat(e.target.value) || 0)}
                min="0"
                step="0.5"
                className="w-full"
              />
              <p className="mt-1 text-xs text-slate-500">Products above this weight are "heavy".</p>
            </div>
            <div>
              <label htmlFor="heavyProductFeePerKg" className="block text-sm font-medium text-slate-700 mb-1">
                Fee per kg (₹)
              </label>
              <Input
                id="heavyProductFeePerKg"
                type="number"
                value={config.heavyProductFeePerKg}
                onChange={(e) => handleChange("heavyProductFeePerKg", parseInt(e.target.value) || 0)}
                min="0"
                className="w-full"
              />
              <p className="mt-1 text-xs text-slate-500">Additional fee per kg above threshold.</p>
            </div>
            <div>
              <label htmlFor="heavyProductBaseFee" className="block text-sm font-medium text-slate-700 mb-1">
                Base Fee (₹)
              </label>
              <Input
                id="heavyProductBaseFee"
                type="number"
                value={config.heavyProductBaseFee}
                onChange={(e) => handleChange("heavyProductBaseFee", parseInt(e.target.value) || 0)}
                min="0"
                className="w-full"
              />
              <p className="mt-1 text-xs text-slate-500">Base delivery fee for heavy products.</p>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex items-center gap-4">
          <Button type="submit" disabled={saving} className="w-full sm:w-auto">
            {saving ? <Spinner className="h-4 w-4" /> : "Save Changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}

interface DeliveryConfig {
  baseFee: number;
  freeOver: number;
  noCodPincodes: string[];
  serviceablePincodes: string[];
  pincodeRates: Record<string, number>;
  heavyProductThresholdKg: number;
  heavyProductFeePerKg: number;
  heavyProductBaseFee: number;
  updatedAt: string;
  createdAt: string;
}
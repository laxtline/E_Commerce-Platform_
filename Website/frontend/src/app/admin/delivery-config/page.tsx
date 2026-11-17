import type { Metadata } from "next";
import { DeliveryManagementPage } from "@/components/storefront/DeliveryManagement";

export const metadata: Metadata = {
  title: "Delivery Configuration · Admin · Ramachandra Traders",
};

export default function DeliveryConfigPage() {
  return <DeliveryManagementPage />;
}
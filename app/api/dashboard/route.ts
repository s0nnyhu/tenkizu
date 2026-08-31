import { NextResponse } from "next/server";
import { cached } from "@/lib/cache";
import { buildDashboard } from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const data = await cached("dashboard:full", 20_000, () => buildDashboard(), 120_000);
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

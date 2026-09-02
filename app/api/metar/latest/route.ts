import { NextResponse } from "next/server";
import { fetchLatestMetars } from "@/lib/tgftp-metar";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: Request) {
  const ids = new URL(req.url).searchParams.get("ids") ?? "";
  const list = ids.split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) {
    return NextResponse.json({ byIcao: {} });
  }
  try {
    const byIcao = await fetchLatestMetars(list);
    return NextResponse.json(
      { byIcao, fetchedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

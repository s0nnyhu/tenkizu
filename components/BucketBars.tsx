"use client";

import type { Bucket } from "@/lib/types";
import { fmtProb } from "@/lib/format";

export function BucketBars({
  buckets,
  consensusLabel,
  wuLabel,
  runningLabel,
}: {
  buckets: Bucket[];
  consensusLabel: string | null;
  wuLabel: string | null;
  runningLabel: string | null;
}) {
  const max = Math.max(0.05, ...buckets.map((b) => b.yesPrice));
  return (
    <div className="buckets">
      {buckets.map((b) => {
        const marks: { cls: string; title: string }[] = [];
        if (b.label === consensusLabel) marks.push({ cls: "cons", title: "consensus" });
        if (b.label === wuLabel) marks.push({ cls: "wu", title: "WU" });
        if (b.label === runningLabel) marks.push({ cls: "run", title: "running max" });
        return (
          <div className="bucket" key={b.id}>
            <span className="num" title={b.question}>
              {b.label}
            </span>
            <div className="bar">
              <i style={{ width: `${(b.yesPrice / max) * 100}%` }} />
              <div className="marks">
                {marks.map((m) => (
                  <span key={m.cls} className={`mark ${m.cls}`} title={m.title} />
                ))}
              </div>
            </div>
            <span className="num">{fmtProb(b.yesPrice)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function PageSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-label="กำลังโหลดข้อมูล">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <div className="h-7 w-64 rounded-lg bg-slate-200" />
          <div className="h-4 w-80 rounded bg-slate-100" />
        </div>
        <div className="h-9 w-36 rounded-lg bg-slate-200" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: cards }).map((_, idx) => (
          <div key={idx} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="h-4 w-28 rounded bg-slate-200" />
            <div className="mt-3 h-8 w-20 rounded bg-slate-200" />
            <div className="mt-2 h-3 w-36 rounded bg-slate-100" />
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="h-5 w-48 rounded bg-slate-200" />
        <div className="mt-4 space-y-2.5">
          <div className="h-10 w-full rounded-lg bg-slate-100" />
          <div className="h-10 w-full rounded-lg bg-slate-100" />
          <div className="h-10 w-5/6 rounded-lg bg-slate-100" />
        </div>
      </div>
    </div>
  );
}

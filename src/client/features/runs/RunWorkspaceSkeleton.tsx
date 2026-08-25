import { Skeleton } from "../../components/ui/skeleton.js";

/**
 * Shaped like RunWorkspace's rail/document/context grid, so the real content
 * settles into place rather than the page jumping. Purely decorative — a
 * visually-hidden status message carries the loading announcement.
 */
export function RunWorkspaceSkeleton() {
  return (
    <div aria-hidden="true" className="mt-8">
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="mb-6 flex gap-1 overflow-x-auto">
        {Array.from({ length: 12 }, (_, index) => (
          <Skeleton key={index} className="h-5 w-8 shrink-0 flex-1 sm:w-auto" />
        ))}
      </div>
      <div className="grid items-start gap-8 md:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[250px_minmax(0,1fr)_320px]">
        <div>
          <div className="mb-3 flex items-center justify-between border-b border-rule pb-2">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
          <ol>
            {Array.from({ length: 12 }, (_, index) => (
              <li key={index} className="grid grid-cols-[28px_1fr] gap-2 border-b border-rule py-3">
                <Skeleton className="h-3 w-6" />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-full max-w-40" />
                  <Skeleton className="h-4 w-16" />
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="min-w-0">
          <div className="mb-3 border-b border-rule pb-3">
            <Skeleton className="h-6 w-48" />
          </div>
          <div className="rounded-group border border-rule bg-paper px-5 py-7 sm:px-8">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="mt-3 h-4 w-1/3" />
            <Skeleton className="mt-5 h-12 w-full" />
            <div className="mt-6 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        </div>

        <div className="border border-rule bg-paper md:col-span-2 xl:col-span-1">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="border-b border-rule px-4 py-4 last:border-b-0">
              <Skeleton className="h-4 w-32" />
              <div className="mt-3 space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

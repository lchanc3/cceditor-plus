import { useEffect, useRef } from 'react';

import { cn } from '../lib/utils';

export interface TabDef {
  id: string;
  label: string;
  /** Set for tabs that are a single long-text field. */
  field?: 'description' | 'personality' | 'scenario' | 'first_mes' | 'mes_example';
  badge?: number;
}

/**
 * Horizontally scrollable on phones, a vertical rail from `lg` up.
 *
 * The previous version laid eight `flex-1 px-6` tabs in a non-scrolling row,
 * which on a 375px screen crushed them into unreadable slivers.
 */
export function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: TabDef[];
  active: string;
  onSelect: (id: string) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // On a phone the strip scrolls, so the selected tab can end up off-screen
  // after a programmatic change; pull it back into view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  return (
    <nav
      aria-label="編輯區段"
      className="scroll-x flex gap-1 border-b border-line px-2 py-2 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:border-b-0 lg:border-r lg:px-2 lg:py-3"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={selected ? activeRef : undefined}
            onClick={() => onSelect(tab.id)}
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'tap shrink-0 scroll-ml-2 whitespace-nowrap rounded px-3.5 py-2 text-sm font-bold transition-colors lg:w-full lg:text-left',
              selected ? 'bg-gold/10 text-gold' : 'text-dim hover:bg-field hover:text-body',
            )}
            style={{ scrollSnapAlign: 'start' }}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span
                className={cn(
                  'ml-2 rounded px-1.5 py-0.5 text-xs tabular-nums',
                  selected ? 'bg-gold/20' : 'bg-field',
                )}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

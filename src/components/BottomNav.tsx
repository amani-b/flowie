import { motion } from "framer-motion";
import { Home, Image, Shirt, Wand2, type LucideIcon } from "lucide-react";
import type { TabId } from "../types";
import { cn } from "../lib/utils";
import { useAppStore } from "../store/appStore";

const TABS: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: "home", label: "Today", icon: Home },
  { id: "closet", label: "Closet", icon: Shirt },
  { id: "studio", label: "Studio", icon: Wand2 },
  { id: "looks", label: "Looks", icon: Image },
];

export default function BottomNav() {
  const tab = useAppStore((s) => s.tab);
  const setTab = useAppStore((s) => s.setTab);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40">
      <div className="mx-auto w-full max-w-md px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]">
        <div className="glass flex h-[64px] items-stretch rounded-[22px] px-1.5 shadow-lg">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  "relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-[16px] transition-colors",
                  active ? "text-acc" : "text-mut hover:text-ink"
                )}
                aria-label={label}
                aria-current={active ? "page" : undefined}
              >
                {active && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute inset-x-3 top-1.5 bottom-1.5 rounded-[14px] bg-accsoft"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  />
                )}
                <Icon className="relative z-10 h-[20px] w-[20px]" strokeWidth={active ? 2.4 : 2} />
                <span className="relative z-10 text-[10px] font-extrabold tracking-wide">
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

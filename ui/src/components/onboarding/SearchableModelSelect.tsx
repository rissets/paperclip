import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export interface SearchableModelOption {
  id: string;
  label?: string;
}

/** Endpoints can expose thousands of models; rendering all of them freezes cmdk. */
const MAX_VISIBLE_OPTIONS = 100;

export function SearchableModelSelect({
  id,
  value,
  options,
  onValueChange,
  placeholder = "Select model",
  searchPlaceholder = "Search models...",
}: {
  id?: string;
  value: string;
  options: SearchableModelOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = options.find((option) => option.id === value);

  const { visible, total } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? options.filter(
          (option) =>
            option.id.toLowerCase().includes(needle) ||
            (option.label ?? "").toLowerCase().includes(needle),
        )
      : options;
    return { visible: matches.slice(0, MAX_VISIBLE_OPTIONS), total: matches.length };
  }, [options, query]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-xs"
        >
          <span className={cn("truncate", !selected && !value && "text-muted-foreground")}>
            {selected ? selected.label || selected.id : value || placeholder}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder={searchPlaceholder} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {visible.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                onSelect={() => {
                  onValueChange(option.id);
                  setOpen(false);
                  setQuery("");
                }}
                className="text-xs"
              >
                <Check className={cn("size-4", option.id === value ? "opacity-100" : "opacity-0")} />
                <span className="truncate">{option.label || option.id}</span>
              </CommandItem>
            ))}
            {total > visible.length ? (
              <div className="px-2 py-1.5 text-center text-xs text-muted-foreground">
                Showing {visible.length} of {total}. Keep typing to narrow results.
              </div>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

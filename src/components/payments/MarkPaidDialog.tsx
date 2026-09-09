import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Hungarian date entry — plain text auto-formatted as ÉÉÉÉ.HH.NN, so no
// browser locale can re-localize it (same approach as the invoice form).
const formatHuDateInput = (raw: string): string => {
  const d = raw.replace(/[^0-9]/g, "").slice(0, 8);
  if (d.length <= 4) return d;
  if (d.length <= 6) return `${d.slice(0, 4)}.${d.slice(4)}`;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
};

// Strict parse of ÉÉÉÉ.HH.NN — rejects impossible dates. Returns YYYY-MM-DD or null.
const parseHuDateInput = (s: string): string | null => {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(s);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (
    dt.getFullYear() !== Number(m[1]) ||
    dt.getMonth() !== Number(m[2]) - 1 ||
    dt.getDate() !== Number(m[3])
  ) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
};

const todayHu = (): string => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}.${mm}.${dd}`;
};

interface MarkPaidDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  onConfirm: (paidAtIso: string) => void;
}

export function MarkPaidDialog({
  open,
  onOpenChange,
  isPending,
  onConfirm,
}: MarkPaidDialogProps) {
  const { t } = useTranslation(["payments", "common"]);
  const [display, setDisplay] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Prefill today on every open.
  useEffect(() => {
    if (open) {
      setDisplay(todayHu());
      setError(null);
    }
  }, [open ]);

  const handleConfirm = () => {
    const ymd = parseHuDateInput(display);
    if (!ymd) {
      setError(t("payments:paid_at_invalid"));
      return;
    }
    const [y, m, d] = ymd.split("-").map(Number);
    onConfirm(new Date(y, m - 1, d).toISOString());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("payments:mark_paid")}</DialogTitle>
          <DialogDescription>{t("payments:paid_at_hint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>{t("payments:paid_at")}</Label>
          <div className="relative">
            <CalendarDays className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
            <Input
              type="text"
              inputMode="numeric"
              placeholder={t("payments:due_date_placeholder")}
              className="pl-10"
              value={display}
              disabled={isPending}
              onChange={(e) => {
                setDisplay(formatHuDateInput(e.target.value));
                setError(null);
              }}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t("common:cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {t("payments:mark_paid")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default MarkPaidDialog;

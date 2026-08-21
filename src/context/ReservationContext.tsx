import React, { createContext, useContext, useState, useCallback } from "react";

interface ReservationContextValue {
  lastViewedId: number | null;
  setLastViewedId: (id: number | null) => void;
}

const ReservationContext = createContext<ReservationContextValue>({
  lastViewedId: null,
  setLastViewedId: () => {},
});

export function ReservationProvider({ children }: { children: React.ReactNode }) {
  const [lastViewedId, setLastViewedId] = useState<number | null>(null);
  return (
    <ReservationContext.Provider value={{ lastViewedId, setLastViewedId }}>
      {children}
    </ReservationContext.Provider>
  );
}

export function useReservationContext() {
  return useContext(ReservationContext);
}

-- Add 'attended' status to reservation_bookings for the calendar status dropdown.
-- 'attended' = the customer showed up (Részt vett), distinct from 'completed'.

ALTER TABLE reservation_bookings
  DROP CONSTRAINT IF EXISTS reservation_bookings_status_check;

ALTER TABLE reservation_bookings
  ADD CONSTRAINT reservation_bookings_status_check
    CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show', 'attended'));

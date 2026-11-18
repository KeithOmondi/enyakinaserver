-- 0004_stock_in_types
-- Stock that arrives outside a supplier purchase is tracked under its own movement types,
-- so the ledger can be filtered by where stock came from:
--   new_stock  newly produced / brought in
--   cold_room  moved out of the cold room onto the shelf

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
    FROM pg_constraint
   WHERE conrelid = 'stock_movements'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%opening%';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_type_check
  CHECK (type IN ('opening', 'purchase', 'sale', 'void', 'adjustment', 'new_stock', 'cold_room'));

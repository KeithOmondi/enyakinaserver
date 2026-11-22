-- 0007_subcategories
-- Categories can have sub-categories, one level deep: Adults > T-shirts, Kids > T-shirts.
-- A product sits in the most specific one. The same sub-category name may exist under different parents.

ALTER TABLE categories ADD COLUMN parent_id uuid REFERENCES categories(id);

DROP INDEX categories_business_name_key;
CREATE UNIQUE INDEX categories_business_parent_name_key
  ON categories (business_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX categories_parent_idx ON categories (parent_id);

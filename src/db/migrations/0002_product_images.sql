-- 0002_product_images
-- Object key of the product photo in Cloudflare R2 (NULL = no photo). The public URL is
-- built from R2_PUBLIC_URL + key, so moving the bucket or domain needs no data change.
ALTER TABLE products ADD COLUMN image_key text;

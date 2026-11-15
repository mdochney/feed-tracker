-- A paid show's per-subscriber feed address. It is a credential: it is stored here (the
-- database is private to the account), never in the repository, and the API never sends
-- it back to the browser.
ALTER TABLE sources ADD COLUMN private_feed_url TEXT;

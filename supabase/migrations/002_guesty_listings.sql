create table if not exists guesty_listings (
  id                text primary key,
  title             text,
  location          text,
  bedrooms          int,
  bathrooms         numeric,
  accommodates      int,
  min_nights        int default 1,
  base_price        numeric,
  currency          text default 'IDR',
  weekly_factor     numeric,
  monthly_factor    numeric,
  weekly_discount   numeric,
  monthly_discount  numeric,
  cleaning_fee      numeric,
  extra_person_fee  numeric default 0,
  security_deposit  numeric,
  imported_at       timestamptz default now()
);

create index if not exists idx_guesty_listings_location on guesty_listings(location);

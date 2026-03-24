-- Guesty calendar import schema
-- Run reservations first (FK dependency)

create table if not exists guesty_reservations (
  id                   text primary key,
  listing_id           text not null,
  account_id           text,
  confirmation_code    text,
  source               text,
  status               text,
  check_in_date        date,
  check_out_date       date,
  check_in             timestamptz,
  check_out            timestamptz,
  nights_count         int,
  guests_count         int,
  num_adults           int default 0,
  num_children         int default 0,
  num_infants          int default 0,
  guest_id             text,
  guest_full_name      text,
  platform             text,
  listing_nickname     text,
  listing_timezone     text,
  listing_check_in_time text,
  balance_due          numeric,
  host_payout          numeric,
  total_paid           numeric,
  fare_accommodation   numeric,
  currency             text default 'IDR',
  guest_stay_status    text,
  created_by           text,
  created_at           timestamptz,
  imported_at          timestamptz default now()
);

create table if not exists guesty_calendar (
  id                  bigserial primary key,
  date                date not null,
  listing_id          text not null,
  currency            text default 'IDR',
  price               numeric,
  base_price          numeric,
  rate_strategy_price numeric,
  min_nights          int default 1,
  max_nights          int default 365,
  status              text,                          -- available | booked
  cta                 boolean default false,         -- close to arrival
  ctd                 boolean default false,         -- close to departure
  request_to_book     boolean default false,
  blocks              jsonb,                         -- raw block flags {m,r,b,bd,...}
  rules_applied       jsonb,                         -- [{rule, adjustmentPercentage}]
  reservation_id      text references guesty_reservations(id),
  imported_at         timestamptz default now(),

  unique(date, listing_id)
);

create index if not exists idx_guesty_calendar_listing_date  on guesty_calendar(listing_id, date);
create index if not exists idx_guesty_calendar_status        on guesty_calendar(status);
create index if not exists idx_guesty_calendar_reservation   on guesty_calendar(reservation_id);

-- -----------------------------------------------------------------------
-- Upsert helpers (call these from your import script)
-- -----------------------------------------------------------------------

-- 1. Upsert a reservation (idempotent)
-- insert into guesty_reservations (id, listing_id, ...)
-- values (...)
-- on conflict (id) do update set
--   status = excluded.status,
--   balance_due = excluded.balance_due,
--   total_paid = excluded.total_paid,
--   imported_at = now();

-- 2. Upsert a calendar day (idempotent)
-- insert into guesty_calendar (date, listing_id, ...)
-- values (...)
-- on conflict (date, listing_id) do update set
--   price = excluded.price,
--   status = excluded.status,
--   reservation_id = excluded.reservation_id,
--   rules_applied = excluded.rules_applied,
--   imported_at = now();

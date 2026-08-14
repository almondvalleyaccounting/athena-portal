-- Accounting year end on the forecast.
--
-- The engine needs to know when the accounting year ends before it can say
-- when the corporation tax on it is paid. Until now the childcare pack had no
-- year-end concept at all: it paid each month's accrued tax nine months later,
-- so CT left the bank in twelve dribbles a year instead of one bill. The
-- general-cashflow pack had `tax.year_end_month` as a driver, which is the
-- right idea in the wrong place — a year end is a fact about the company, not
-- an assumption that varies by scenario.
--
-- Stored as a full date rather than a month number so it reads back the way an
-- accountant says it ("31 July"). Only the month is used by the monthly model;
-- the day is for display.
--
-- NULL = unknown. The engine falls back to the month before the forecast
-- opens, so year one still ends twelve months in and existing forecasts keep
-- their shape.

alter table fc_forecast add column if not exists year_end_date date;

comment on column fc_forecast.year_end_date is
  'Accounting year end (e.g. 2027-07-31). Month drives the CT payment date: year end + tax.payment_lag_months. NULL = the month before opening_period.';

-- Puddleduck's year end is 31 July, so CT falls due 30 April.
update fc_forecast
   set year_end_date = date '2027-07-31'
 where name = 'Puddleduck Expansion'
   and year_end_date is null;

-- The general-cashflow forecast already carried a year end as a driver
-- (tax.year_end_month = 3). Set the column to match so behaviour is unchanged
-- and the driver stops being the source of truth.
update fc_forecast
   set year_end_date = date '2027-03-31'
 where vertical_pack = 'general_cashflow'
   and year_end_date is null;

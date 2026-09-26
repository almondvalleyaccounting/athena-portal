-- 326: a new quote can supersede an open one for the same client.
--
-- Mark Tortolano had two quotes in the pipeline, both "Sent", when the
-- second was meant to replace the first — so the pipeline counted him
-- twice. Starting a quote for a client who already has an open one now
-- asks whether it replaces that quote or sits beside it.
--
-- The new quote is inserted carrying `supersedes` (the quote it replaces).
-- An AFTER INSERT trigger marks that quote 'superseded' and points it back
-- (`superseded_by`), in the same statement — so the link is made by the
-- database, not remembered by the browser, and only ever between quotes of
-- the same client. 'superseded' is terminal apart from soft delete, and
-- leaves the pipeline (it is not one of the pipeline statuses), while the
-- quote itself stays readable.
--
-- The trigger runs as the inserting user (SECURITY INVOKER), so the update
-- is subject to the same "Staff can update quotes" policy as any other.

alter table public.quotes
  add column if not exists supersedes uuid references public.quotes(id),
  add column if not exists superseded_by uuid references public.quotes(id),
  add column if not exists superseded_at timestamptz;

alter table public.quotes drop constraint if exists quotes_status_check;
alter table public.quotes add constraint quotes_status_check check (status = any (array[
  'draft', 'pending_approval', 'approved', 'sent', 'accepted', 'declined', 'expired', 'committed', 'deleted', 'superseded'
]::text[]));

-- A superseded quote always says what replaced it.
alter table public.quotes drop constraint if exists quotes_superseded_has_replacement;
alter table public.quotes add constraint quotes_superseded_has_replacement
  check (status <> 'superseded' or superseded_by is not null);

-- Status transitions: an open quote may become 'superseded' (only with the
-- replacement set); 'superseded' goes nowhere but 'deleted'.
create or replace function public.tg_quotes_validate_status_fn()
returns trigger
language plpgsql
as $function$
BEGIN
  -- Self-transition (status unchanged, other fields modified): always allowed.
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- 'deleted' is fully terminal.
  IF OLD.status = 'deleted' THEN
    RAISE EXCEPTION 'Quote is in terminal state (%) — transitions not permitted', OLD.status;
  END IF;

  -- 'committed' is locked once verified in QB. Before verification it can be
  -- reverted to 'accepted' (e.g. when the QBO push didn't actually land).
  IF OLD.status = 'committed' THEN
    IF OLD.qbo_verified_at IS NOT NULL THEN
      RAISE EXCEPTION 'Quote is locked (verified in QB) — transitions not permitted';
    END IF;
    IF NEW.status = 'accepted' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
  END IF;

  -- Soft delete is always available from any non-terminal status.
  IF NEW.status = 'deleted' THEN
    RETURN NEW;
  END IF;

  -- Replaced by a newer quote for the same client (sql/326).
  IF NEW.status = 'superseded' THEN
    IF OLD.status IN ('draft', 'pending_approval', 'approved', 'sent', 'accepted') AND NEW.superseded_by IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Only an open quote can be superseded, and only by another quote';
  END IF;
  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'Quote was superseded — transitions not permitted';
  END IF;

  -- Explicit transition table for all other cases.
  IF NOT (
       (OLD.status = 'draft'            AND NEW.status = 'pending_approval')
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'declined'))
    OR (OLD.status = 'approved'         AND NEW.status = 'sent')
    OR (OLD.status = 'sent'             AND NEW.status IN ('accepted', 'declined', 'expired'))
    OR (OLD.status = 'accepted'         AND NEW.status = 'committed')
    OR (OLD.status = 'declined'         AND NEW.status = 'draft')
    OR (OLD.status = 'expired'          AND NEW.status = 'draft')
  ) THEN
    RAISE EXCEPTION 'Invalid quote status transition: % → %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$function$;

-- The new quote supersedes the one it names: same client, still open.
create or replace function public.tg_quotes_supersede_fn()
returns trigger
language plpgsql
security invoker
set search_path = public
as $function$
declare
  hit int;
begin
  if new.supersedes is null then
    return new;
  end if;
  if new.supersedes = new.id then
    raise exception 'A quote cannot supersede itself';
  end if;
  update public.quotes
     set status = 'superseded', superseded_by = new.id, superseded_at = now()
   where id = new.supersedes
     and entity_id is not distinct from new.entity_id
     and status in ('draft', 'pending_approval', 'approved', 'sent', 'accepted');
  get diagnostics hit = row_count;
  if hit = 0 then
    raise exception 'The quote being replaced is not an open quote for this client';
  end if;
  return new;
end;
$function$;

drop trigger if exists tg_quotes_supersede on public.quotes;
create trigger tg_quotes_supersede
  after insert on public.quotes
  for each row when (new.supersedes is not null)
  execute function public.tg_quotes_supersede_fn();

-- Trigger functions need no EXECUTE for anyone; new functions get it from
-- the schema default (anon included), so take it away explicitly.
revoke all on function public.tg_quotes_supersede_fn() from public, anon, authenticated;

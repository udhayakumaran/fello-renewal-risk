-- The model is re-learned monthly and reused on the other nights, so what past customers did with
-- and without each clue is stored beside the points it produced.
alter table models add column evidence jsonb;

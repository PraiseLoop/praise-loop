-- The Business tier adds one plan key; existing rows keep their plan and data.
ALTER TABLE owner_plans DROP CONSTRAINT owner_plans_plan_check;
ALTER TABLE owner_plans ADD CONSTRAINT owner_plans_plan_check CHECK (plan IN ('free','pro','business'));

-- Correction for 0044: the runtime role's grants on task_files
-- are column-level, so the new scan_status column was not
-- readable or writable by nexora_app (42501 on upload). Grant
-- the column explicitly. db/runtime-grants.sql is updated in the
-- same change so fresh databases get the full lists at once;
-- the migrator reapplies runtime-grants on every run.
GRANT SELECT (scan_status), INSERT (scan_status), UPDATE (scan_status)
ON TABLE nexora.task_files TO nexora_app;

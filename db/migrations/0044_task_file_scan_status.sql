-- Task file malware scan status (approved default, 2026-10-26).
-- 'pending' means no scanner was configured when the file was
-- uploaded, or the file predates scanning: it is NOT a claim that
-- the file is clean. 'clean' means a configured scanner reported
-- clean at upload (or at a later rescan). 'quarantined' means a
-- configured scanner reported infected, or the scanner was
-- unavailable when the file was scanned: the bytes are kept, the
-- row is kept, but downloads are blocked (409 FILE_QUARANTINED)
-- until a rescan clears it. Existing rows default to 'pending',
-- which is honest about files uploaded before scanning existed.
ALTER TABLE nexora.task_files
  ADD COLUMN scan_status text NOT NULL DEFAULT 'pending'
    CONSTRAINT task_files_scan_status_check
      CHECK (scan_status IN ('pending', 'clean', 'quarantined'));

-- No new index: downloads already read by primary key, and the
-- rescan script reads pending rows by the existing
-- organization/project/task ordering.

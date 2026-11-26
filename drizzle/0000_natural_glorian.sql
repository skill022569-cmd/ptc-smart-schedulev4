CREATE TABLE `accounts` (
	`id` varchar(36) NOT NULL,
	`username` varchar(50) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`role` enum('admin','scheduler','teacher','student','viewer') NOT NULL,
	`staff_id` varchar(36),
	`student_id` varchar(36),
	`last_login_at` timestamp,
	CONSTRAINT `accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `accounts_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` varchar(36) NOT NULL,
	`account_id` varchar(36),
	`action` varchar(50) NOT NULL,
	`entity` varchar(50),
	`entity_id` varchar(36),
	`before_data` json,
	`after_data` json,
	`created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `buildings` (
	`id` varchar(36) NOT NULL,
	`code` varchar(10),
	`name` varchar(100) NOT NULL,
	CONSTRAINT `buildings_id` PRIMARY KEY(`id`),
	CONSTRAINT `buildings_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `challenge_rules` (
	`id` varchar(36) NOT NULL,
	`term_id` varchar(36) NOT NULL,
	`category` enum('time','room','subject','teacher') NOT NULL,
	`rule_type` varchar(40) NOT NULL,
	`target` json NOT NULL,
	`params` json NOT NULL,
	`mode` enum('hard','soft') DEFAULT 'hard',
	`description` text,
	`is_active` boolean DEFAULT true,
	`created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `challenge_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `consent_records` (
	`id` varchar(36) NOT NULL,
	`account_id` varchar(36) NOT NULL,
	`policy_version` varchar(20) NOT NULL,
	`consented_at` timestamp NOT NULL,
	`withdrawn_at` timestamp,
	CONSTRAINT `consent_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `constraint_configs` (
	`id` varchar(36) NOT NULL,
	`profile_name` varchar(50) NOT NULL,
	`code` varchar(40) NOT NULL,
	`mode` enum('hard','soft','off') NOT NULL,
	`weight` int DEFAULT 0,
	`params` json,
	CONSTRAINT `constraint_configs_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_cc` UNIQUE(`profile_name`,`code`)
);
--> statement-breakpoint
CREATE TABLE `course_offerings` (
	`id` varchar(36) NOT NULL,
	`term_id` varchar(36) NOT NULL,
	`subject_id` varchar(36) NOT NULL,
	`offering_type` enum('regular','combined','split','team','elective_section','activity') DEFAULT 'regular',
	`periods_per_week` int NOT NULL,
	`split_pattern` json NOT NULL,
	`room_type_id` varchar(36),
	`section_no` int,
	`max_students` int,
	CONSTRAINT `course_offerings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `departments` (
	`id` varchar(36) NOT NULL,
	`code` varchar(20),
	`name` varchar(100) NOT NULL,
	CONSTRAINT `departments_id` PRIMARY KEY(`id`),
	CONSTRAINT `departments_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `elective_enrollments` (
	`student_id` varchar(36) NOT NULL,
	`term_id` varchar(36) NOT NULL,
	`subject_id` varchar(36) NOT NULL,
	`offering_id` varchar(36),
	CONSTRAINT `elective_enrollments_student_id_term_id_pk` PRIMARY KEY(`student_id`,`term_id`)
);
--> statement-breakpoint
CREATE TABLE `fixed_blocks` (
	`id` varchar(36) NOT NULL,
	`term_id` varchar(36) NOT NULL,
	`name` varchar(100) NOT NULL,
	`block_type` enum('activity','elective_block','closed') NOT NULL,
	`day_of_week` tinyint NOT NULL,
	`start_period` int NOT NULL,
	`duration` int NOT NULL,
	`room_id` varchar(36),
	`applies_to` json NOT NULL,
	CONSTRAINT `fixed_blocks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` varchar(36) NOT NULL,
	`file_name` varchar(200) NOT NULL,
	`status` enum('uploaded','validated','has_errors','committed') NOT NULL,
	`stats` json,
	`issues` json,
	`created_by` varchar(36),
	`created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `import_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `issue_reports` (
	`id` varchar(36) NOT NULL,
	`reporter_id` varchar(36) NOT NULL,
	`category` enum('teacher_leave','room_outage','schedule_conflict','system_bug') NOT NULL,
	`affected_date` date NOT NULL,
	`affected_staff_id` varchar(36),
	`affected_room_id` varchar(36),
	`description` text,
	`status` enum('open','proposed','applied','closed') DEFAULT 'open',
	`agent_proposal` json,
	`created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `issue_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `offering_groups` (
	`offering_id` varchar(36) NOT NULL,
	`group_id` varchar(36) NOT NULL,
	CONSTRAINT `offering_groups_offering_id_group_id_pk` PRIMARY KEY(`offering_id`,`group_id`)
);
--> statement-breakpoint
CREATE TABLE `offering_teachers` (
	`offering_id` varchar(36) NOT NULL,
	`staff_id` varchar(36) NOT NULL,
	`subgroup_code` char(1),
	`role` enum('main','co') DEFAULT 'main',
	CONSTRAINT `offering_teachers_offering_id_staff_id_pk` PRIMARY KEY(`offering_id`,`staff_id`)
);
--> statement-breakpoint
CREATE TABLE `room_types` (
	`id` varchar(36) NOT NULL,
	`code` varchar(30) NOT NULL,
	`name` varchar(100) NOT NULL,
	`is_lab` boolean DEFAULT false,
	CONSTRAINT `room_types_id` PRIMARY KEY(`id`),
	CONSTRAINT `room_types_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` varchar(36) NOT NULL,
	`room_code` varchar(30) NOT NULL,
	`building_id` varchar(36) NOT NULL,
	`room_type_id` varchar(36) NOT NULL,
	`capacity` int NOT NULL,
	`allow_multi_group` boolean DEFAULT false,
	`features` json,
	`unavailable_slots` json,
	CONSTRAINT `rooms_id` PRIMARY KEY(`id`),
	CONSTRAINT `rooms_room_code_unique` UNIQUE(`room_code`)
);
--> statement-breakpoint
CREATE TABLE `schedule_exceptions` (
	`id` varchar(36) NOT NULL,
	`version_id` varchar(36) NOT NULL,
	`issue_id` varchar(36),
	`item_id` varchar(36) NOT NULL,
	`exception_date` date NOT NULL,
	`action` enum('substitute','room_change','makeup','cancel') NOT NULL,
	`substitute_staff_id` varchar(36),
	`new_room_id` varchar(36),
	`makeup_date` date,
	`makeup_period` int,
	CONSTRAINT `schedule_exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `schedule_item_teachers` (
	`item_id` varchar(36) NOT NULL,
	`staff_id` varchar(36) NOT NULL,
	CONSTRAINT `schedule_item_teachers_item_id_staff_id_pk` PRIMARY KEY(`item_id`,`staff_id`)
);
--> statement-breakpoint
CREATE TABLE `schedule_items` (
	`id` varchar(36) NOT NULL,
	`version_id` varchar(36) NOT NULL,
	`offering_id` varchar(36) NOT NULL,
	`segment_index` tinyint NOT NULL,
	`subgroup_id` varchar(36),
	`room_id` varchar(36),
	`day_of_week` tinyint,
	`start_period` int,
	`duration` int NOT NULL,
	`status` enum('scheduled','unplaced_tray') DEFAULT 'scheduled',
	`is_locked` boolean DEFAULT false,
	`explanation` json,
	`row_version` int DEFAULT 1,
	`updated_by` varchar(36),
	`updated_at` timestamp,
	CONSTRAINT `schedule_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `schedule_versions` (
	`id` varchar(36) NOT NULL,
	`term_id` varchar(36) NOT NULL,
	`name` varchar(150) NOT NULL,
	`source` enum('run','manual','restore','repair') NOT NULL,
	`status` enum('draft','published','archived') DEFAULT 'draft',
	`parent_version_id` varchar(36),
	`created_by` varchar(36),
	`created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT `schedule_versions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scheduling_runs` (
	`id` varchar(36) NOT NULL,
	`term_id` varchar(36) NOT NULL,
	`scenario_code` varchar(30),
	`algorithm` enum('greedy','csp_ga','csp_sa','cpsat') NOT NULL,
	`profile_name` varchar(50) NOT NULL,
	`seed` int NOT NULL,
	`max_iterations` int NOT NULL,
	`time_limit_sec` int DEFAULT 180,
	`status` enum('queued','running','done','failed','cancelled') DEFAULT 'queued',
	`progress_pct` tinyint DEFAULT 0,
	`started_at` timestamp,
	`finished_at` timestamp,
	`duration_ms` int,
	`hard_violations` int,
	`soft_score` decimal(12,2),
	`fitness` decimal(12,4),
	`unplaced_count` int,
	`metrics` json,
	`agent_log` json,
	`version_id` varchar(36),
	CONSTRAINT `scheduling_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `slot_occupancy` (
	`version_id` varchar(36) NOT NULL,
	`day_of_week` tinyint NOT NULL,
	`period` int NOT NULL,
	`resource_type` enum('teacher','group','subgroup','room') NOT NULL,
	`resource_id` varchar(36) NOT NULL,
	`item_id` varchar(36) NOT NULL,
	CONSTRAINT `uq_no_clash` UNIQUE(`version_id`,`day_of_week`,`period`,`resource_type`,`resource_id`)
);
--> statement-breakpoint
CREATE TABLE `staff` (
	`id` varchar(36) NOT NULL,
	`employee_code` varchar(20) NOT NULL,
	`full_name` varchar(150) NOT NULL,
	`department_id` varchar(36),
	`position` varchar(100),
	`staff_type` enum('teacher','guest_lecturer','staff') DEFAULT 'teacher',
	`phone_encrypted` varbinary(255),
	`max_daily_periods` int DEFAULT 6,
	`max_consecutive` int DEFAULT 3,
	`max_weekly_periods` int DEFAULT 24,
	`day_off` tinyint,
	`available_slots` json,
	`unavailable_slots` json,
	CONSTRAINT `staff_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_employee_code_unique` UNIQUE(`employee_code`)
);
--> statement-breakpoint
CREATE TABLE `student_groups` (
	`id` varchar(36) NOT NULL,
	`group_code` varchar(30) NOT NULL,
	`department_id` varchar(36) NOT NULL,
	`level` enum('ปวช.','ปวส.') NOT NULL,
	`year_no` tinyint NOT NULL,
	`program_type` enum('ปกติ','ทวิภาคี','ภาคสมทบ') DEFAULT 'ปกติ',
	`student_count` int NOT NULL,
	`lunch_period` int NOT NULL,
	`allowed_days` json NOT NULL,
	`allowed_shift` enum('day','evening','both') DEFAULT 'day',
	`unavailable_slots` json,
	CONSTRAINT `student_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `student_groups_group_code_unique` UNIQUE(`group_code`)
);
--> statement-breakpoint
CREATE TABLE `students` (
	`id` varchar(36) NOT NULL,
	`student_code` varchar(20) NOT NULL,
	`full_name` varchar(150) NOT NULL,
	`group_id` varchar(36) NOT NULL,
	`subgroup_id` varchar(36),
	CONSTRAINT `students_id` PRIMARY KEY(`id`),
	CONSTRAINT `students_student_code_unique` UNIQUE(`student_code`)
);
--> statement-breakpoint
CREATE TABLE `subgroups` (
	`id` varchar(36) NOT NULL,
	`group_id` varchar(36) NOT NULL,
	`code` char(1) NOT NULL,
	`student_count` int NOT NULL,
	CONSTRAINT `subgroups_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_sub` UNIQUE(`group_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` varchar(36) NOT NULL,
	`subject_code` varchar(30) NOT NULL,
	`curriculum_year` int NOT NULL,
	`subject_name` varchar(200) NOT NULL,
	`theory_hours` int DEFAULT 0,
	`practice_hours` int DEFAULT 0,
	`credits` int NOT NULL,
	`category` enum('general','core','elective','activity') NOT NULL,
	`required_room_type_id` varchar(36),
	`default_split` json,
	`must_be_consecutive` boolean DEFAULT false,
	`time_preference` enum('any','morning','afternoon') DEFAULT 'any',
	CONSTRAINT `subjects_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_subject` UNIQUE(`subject_code`,`curriculum_year`)
);
--> statement-breakpoint
CREATE TABLE `teacher_subject_eligibility` (
	`staff_id` varchar(36) NOT NULL,
	`subject_id` varchar(36) NOT NULL,
	`group_id` varchar(36),
	CONSTRAINT `teacher_subject_eligibility_staff_id_subject_id_pk` PRIMARY KEY(`staff_id`,`subject_id`)
);
--> statement-breakpoint
CREATE TABLE `terms` (
	`id` varchar(36) NOT NULL,
	`academic_year` int NOT NULL,
	`semester` tinyint NOT NULL,
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	CONSTRAINT `terms_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_term` UNIQUE(`academic_year`,`semester`)
);
--> statement-breakpoint
CREATE TABLE `time_slots` (
	`id` varchar(36) NOT NULL,
	`term_id` varchar(36) NOT NULL,
	`period` int NOT NULL,
	`start_time` time NOT NULL,
	`end_time` time NOT NULL,
	`shift` enum('day','evening') NOT NULL,
	`open_days` json NOT NULL,
	CONSTRAINT `time_slots_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_slot` UNIQUE(`term_id`,`period`)
);
--> statement-breakpoint
ALTER TABLE `course_offerings` ADD CONSTRAINT `course_offerings_term_id_terms_id_fk` FOREIGN KEY (`term_id`) REFERENCES `terms`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `course_offerings` ADD CONSTRAINT `course_offerings_subject_id_subjects_id_fk` FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_building_id_buildings_id_fk` FOREIGN KEY (`building_id`) REFERENCES `buildings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rooms` ADD CONSTRAINT `rooms_room_type_id_room_types_id_fk` FOREIGN KEY (`room_type_id`) REFERENCES `room_types`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staff` ADD CONSTRAINT `staff_department_id_departments_id_fk` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `student_groups` ADD CONSTRAINT `student_groups_department_id_departments_id_fk` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `students` ADD CONSTRAINT `students_group_id_student_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `student_groups`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subgroups` ADD CONSTRAINT `subgroups_group_id_student_groups_id_fk` FOREIGN KEY (`group_id`) REFERENCES `student_groups`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `time_slots` ADD CONSTRAINT `time_slots_term_id_terms_id_fk` FOREIGN KEY (`term_id`) REFERENCES `terms`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_logs` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_items_version` ON `schedule_items` (`version_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_occ_item` ON `slot_occupancy` (`item_id`);
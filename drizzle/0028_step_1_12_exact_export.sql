ALTER TABLE "export_manifests" ADD COLUMN "render_content_hash" text;
--> statement-breakpoint
UPDATE "export_manifests" SET "render_content_hash" = manifest->>'content_hash' WHERE "render_content_hash" IS NULL;
--> statement-breakpoint
ALTER TABLE "export_manifests" ALTER COLUMN "render_content_hash" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "export_manifests" ADD CONSTRAINT "export_manifests_hash_lengths" CHECK (length("manifest_hash") = 64 AND length("render_hash") = 64 AND length("render_content_hash") = 64);
--> statement-breakpoint
ALTER TABLE "content_templates" ADD CONSTRAINT "content_templates_hash_length" CHECK (length("content_hash") = 64);
--> statement-breakpoint
INSERT INTO content_templates(id,template_id,version,kind,status,body,content_hash)
VALUES
('00000000-0000-4000-8000-000000000101','mobelaris.writer-submission','1.0.0','writer_submission','pending_editorial_approval',
 '{"section_order":["Metadata","Body copy","Images","FAQ","Internal links used","Schema requirements","Translatable elements","Fact-check claims","Outstanding rejected findings"],"required_metadata":["H1","Author","Date","URL slug","Meta title","Meta description","OG title","OG description"]}'::jsonb,
 encode(digest('{"section_order":["Metadata","Body copy","Images","FAQ","Internal links used","Schema requirements","Translatable elements","Fact-check claims","Outstanding rejected findings"],"required_metadata":["H1","Author","Date","URL slug","Meta title","Meta description","OG title","OG description"]}','sha256'),'hex')),
('00000000-0000-4000-8000-000000000102','mobelaris.blog-schema','1.0.0','blog_schema','pending_editorial_approval',
 '{"requirements":["Article: headline, description, date, author (Mobelaris), image list","FAQPage: one Question/Answer pair per exported FAQ, answerText verbatim","BreadcrumbList: blog section path; exact approved template remains pending"]}'::jsonb,
 encode(digest('{"requirements":["Article: headline, description, date, author (Mobelaris), image list","FAQPage: one Question/Answer pair per exported FAQ, answerText verbatim","BreadcrumbList: blog section path; exact approved template remains pending"]}','sha256'),'hex'))
ON CONFLICT(template_id,version) DO NOTHING;

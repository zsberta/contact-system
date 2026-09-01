import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Send, Mail } from "lucide-react";
import { toast } from "sonner";
import { getAllProjectsPaged, sendBulkEmail } from "@/lib/api";
import type { ProjectDTO } from "@/types/project";

const BulkEmailPage: React.FC = () => {
  const { t } = useTranslation(["bulk-email", "common"]);

  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const { data: projectsData, isLoading: isProjectsLoading } = useQuery({
    queryKey: ["projects", "bulk-email-selector"],
    queryFn: () =>
      getAllProjectsPaged({ page: 0, size: 500, sortField: "name", sortOrder: "asc" }),
  });

  const projects = projectsData?.content ?? [];

  const sendMutation = useMutation({
    mutationFn: sendBulkEmail,
    onSuccess: (data) => {
      toast.success(
        t("bulk-email:send_success", {
          count: data.emailsQueued,
          defaultValue: `${data.emailsQueued} email(s) queued for sending.`,
        }),
      );
      setSubject("");
      setBody("");
    },
    onError: (error: Error) => {
      toast.error(error.message || t("bulk-email:send_error", "Failed to send emails."));
    },
  });

  const handleSend = () => {
    if (!selectedProjectId) {
      toast.error(t("bulk-email:select_project", "Please select a project."));
      return;
    }
    if (!subject.trim()) {
      toast.error(t("bulk-email:enter_subject", "Please enter a subject."));
      return;
    }
    if (!body.trim()) {
      toast.error(t("bulk-email:enter_body", "Please enter a message."));
      return;
    }

    sendMutation.mutate({
      projectId: Number(selectedProjectId),
      subject: subject.trim(),
      body: body.trim(),
    });
  };

  const selectedProject = projects.find(
    (p: ProjectDTO) => p.id === Number(selectedProjectId),
  );

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            {t("bulk-email:title", "Bulk Email")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Project selector */}
          <div className="space-y-2">
            <Label htmlFor="project">{t("bulk-email:project", "Project")}</Label>
            <Select
              value={selectedProjectId}
              onValueChange={setSelectedProjectId}
              disabled={isProjectsLoading}
            >
              <SelectTrigger id="project">
                <SelectValue
                  placeholder={t("bulk-email:select_project_placeholder", "Select a project...")}
                />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project: ProjectDTO) => (
                  <SelectItem key={project.id} value={String(project.id)}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProject && (
              <p className="text-sm text-muted-foreground">
                {t("bulk-email:will_send_to", "Emails will be sent to all active reservation customers of this project.")}
              </p>
            )}
          </div>

          {/* Subject */}
          <div className="space-y-2">
            <Label htmlFor="subject">{t("bulk-email:subject", "Subject")}</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("bulk-email:subject_placeholder", "Enter email subject...")}
            />
          </div>

          {/* Message body */}
          <div className="space-y-2">
            <Label htmlFor="body">{t("bulk-email:message", "Message")}</Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("bulk-email:message_placeholder", "Type your message here... Newlines will be preserved in the email.")}
              rows={10}
              className="min-h-[200px] resize-y font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {t("bulk-email:newline_hint", "Newlines are preserved in the email. Use blank lines to separate paragraphs.")}
            </p>
          </div>

          {/* Send button */}
          <div className="flex justify-end">
            <Button
              onClick={handleSend}
              disabled={sendMutation.isPending || isProjectsLoading}
              size="lg"
            >
              <Send className="mr-2 h-4 w-4" />
              {sendMutation.isPending
                ? t("bulk-email:sending", "Sending...")
                : t("bulk-email:send", "Send Email")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default BulkEmailPage;

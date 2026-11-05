import { createPortal } from "react-dom";
import { Modal } from "./Modal";
import SavePackForm from "./SavePackForm";
import { toast } from "../toast";
import type { ProjectStepDto, StepParamDto } from "../types";

/**
 * 弹层里的「存成我的任务」（2026-11-05 接活三期）：派活单验收后、内置科研任务「另存为我的版本」共用，
 * 里面就是项目设置里的那张另存表单（同一套参数、机器检查、同名覆盖确认），不另写一套。
 */
export default function SavePackModal({
  open,
  title,
  steps,
  initialName,
  initialDescription,
  initialParams,
  intro,
  onClose,
}: {
  open: boolean;
  title: string;
  steps: ProjectStepDto[];
  initialName?: string;
  initialDescription?: string;
  initialParams?: StepParamDto[];
  intro?: string;
  onClose: () => void;
}) {
  // 挂到 body：新建目标弹窗本身是表单，表单里不能再嵌表单
  return createPortal(
    <Modal open={open} title={title} onClose={onClose} size="lg" layer="overlay">
      {open && (
        <SavePackForm
          steps={steps}
          initialName={initialName}
          initialDescription={initialDescription}
          initialParams={initialParams}
          intro={intro}
          onCancel={onClose}
          onSaved={(message) => {
            toast(message, "success");
            onClose();
          }}
        />
      )}
    </Modal>,
    document.body,
  );
}

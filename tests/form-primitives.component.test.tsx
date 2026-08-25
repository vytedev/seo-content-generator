import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Field,
  FieldContent,
  FieldError,
  FieldLegend,
  FieldSet,
} from "../src/client/components/ui/field.js";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "../src/client/components/ui/native-select.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src/client/components/ui/select.js";

afterEach(cleanup);

describe("form primitives", () => {
  it("standardises value selectors while preserving action dropdowns", () => {
    for (const file of [
      "src/client/features/checker/DraftChecker.tsx",
      "src/client/features/findings/FindingsReview.tsx",
      "src/client/pages/CalibrationPage.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toContain("<Select");
      expect(source).not.toContain("NativeSelect");
      expect(source).not.toMatch(/className=[^\n]*capitalize/);
    }

    const sidebar = readFileSync(
      resolve(process.cwd(), "src/client/components/AppSidebar.tsx"),
      "utf8",
    );
    expect(sidebar).toContain("<DropdownMenu>");
    expect(sidebar).toContain("<DropdownMenuItem");
  });
  it("exposes semantic field composition, orientation and error arrays", () => {
    render(
      <FieldSet>
        <FieldLegend>Preferences</FieldLegend>
        <Field orientation="horizontal" data-invalid="true">
          <FieldContent>
            <FieldError
              id="preference-error"
              errors={[
                { message: "Choose a format." },
                { message: "Choose a format." },
                { message: "Try again." },
              ]}
            />
          </FieldContent>
        </Field>
      </FieldSet>,
    );

    expect(screen.getByRole("group", { name: "Preferences" })).toBeInTheDocument();
    const field = screen.getByText("Choose a format.").closest('[data-slot="field"]');
    expect(field).toHaveAttribute("data-orientation", "horizontal");
    expect(field).toHaveAttribute("data-invalid", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("supports Radix keyboard selection, disabled items and restrained popup sizing", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Field>
        <label htmlFor="page-type">Page type</label>
        <Select defaultValue="blog" onValueChange={onValueChange}>
          <SelectTrigger id="page-type" aria-describedby="page-type-help">
            <SelectValue placeholder="Choose page type" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="blog">Blog post</SelectItem>
              <SelectItem value="for_qa">For QA</SelectItem>
              <SelectItem value="google_docs" disabled>
                Google Docs
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <p id="page-type-help">Choose where this content belongs.</p>
      </Field>,
    );

    const trigger = screen.getByRole("combobox", { name: "Page type" });
    expect(trigger).toHaveAttribute("data-slot", "select-trigger");
    expect(trigger).toHaveAttribute("aria-describedby", "page-type-help");
    expect(trigger.className).toContain("rounded-field");
    expect(trigger.className).toContain("focus-visible:ring-3");
    expect(trigger.className).not.toContain("capitalize");

    trigger.focus();
    await user.keyboard("{Enter}{ArrowDown}{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("for_qa");
    expect(trigger).toHaveTextContent("For QA");

    await user.keyboard("{Enter}{End}{Enter}");
    expect(onValueChange).not.toHaveBeenCalledWith("google_docs");

    await user.click(trigger);
    const popup = screen.getByRole("listbox");
    expect(popup.className).toContain("min-w-(--radix-select-trigger-width)");
    expect(popup.className).toContain("max-w-[calc(100vw-2rem)]");
    expect(screen.getByRole("option", { name: "Google Docs" })).toHaveAttribute(
      "data-disabled",
      "",
    );
  });

  it("retains NativeSelect only as an explicit native-platform primitive", () => {
    render(
      <NativeSelect aria-label="Format">
        <NativeSelectOption value="plain">Plain</NativeSelectOption>
        <NativeSelectOptGroup label="Structured">
          <NativeSelectOption value="markdown">Markdown</NativeSelectOption>
        </NativeSelectOptGroup>
      </NativeSelect>,
    );

    expect(screen.getByRole("option", { name: "Plain" })).toHaveAttribute(
      "data-slot",
      "native-select-option",
    );
    expect(screen.getByRole("group", { name: "Structured" })).toHaveAttribute(
      "data-slot",
      "native-select-opt-group",
    );
  });
});

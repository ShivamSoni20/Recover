import { createFileRoute, Outlet } from "@tanstack/react-router";
import { DemoHeader } from "@/components/demo/DemoHeader";

export const Route = createFileRoute("/demo")({
  component: DemoLayout,
});

function DemoLayout() {
  return (
    <div className="min-h-screen bg-background">
      <DemoHeader />
      <div className="animate-in fade-in duration-200">
        <Outlet />
      </div>
    </div>
  );
}

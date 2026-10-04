import { getMachineService, initMachineService, programFailureMessage } from "./IMachineService";
import { MachinePosixService } from "./implementations/MachinePosixService";
import { MachineWindowsService, escapeCmdArg } from "./implementations/MachineWindowsService";

describe("MachineService selection", () => {
  it("picks the implementation for the current platform and caches it", () => {
    const s = initMachineService();
    const isWin = process.platform === "win32";
    expect(s instanceof MachineWindowsService).toBe(isWin);
    expect(s instanceof MachinePosixService).toBe(!isWin);
    expect(getMachineService()).toBe(s);
  });
});

describe("escapeCmdArg (Windows command-line escaping)", () => {
  it("wraps plain arguments in quotes", () => {
    expect(escapeCmdArg("a b")).toBe('"a b"');
  });

  it("escapes embedded quotes", () => {
    expect(escapeCmdArg('a"b')).toBe('"a\\"b"');
  });

  it("doubles trailing backslashes so the closing quote is not escaped", () => {
    expect(escapeCmdArg("a\\")).toBe('"a\\\\"');
  });
});

describe("MachineWindowsService.commandLine", () => {
  const s = new MachineWindowsService();

  it("wraps .bat/.cmd in cmd.exe /d /s /c", () => {
    expect(s.commandLine("gen.bat", ["--prompt", "hi"])).toBe('cmd.exe /d /s /c ""gen.bat" "--prompt" "hi""');
  });

  it("runs .ps1 through powershell.exe -File", () => {
    expect(s.commandLine("gen.ps1", ["-Prompt", "hi"])).toBe(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File gen.ps1 "-Prompt" "hi"',
    );
  });

  it("shows a plain executable as-is", () => {
    expect(s.commandLine("gen.exe", ["a b"])).toBe('gen.exe "a b"');
  });
});

describe("MachinePosixService", () => {
  const s = new MachinePosixService();

  it("shows the plain invocation with quoted args", () => {
    expect(s.commandLine("gen.sh", ["a b"])).toBe('gen.sh "a b"');
  });

  it("refuses .bat/.cmd programs up front (a Windows format)", async () => {
    await expect(s.runProgram("gen.bat", [], () => undefined)).rejects.toThrow(/only supported on Windows/);
    await expect(s.runProgram("gen.cmd", [], () => undefined)).rejects.toThrow(/only supported on Windows/);
  });
});

describe("programFailureMessage", () => {
  it("carries the code, the command line and the full output", () => {
    const msg = programFailureMessage(3, 'gen.sh "x"', "out1", "err1");
    expect(msg).toContain("The program exited with code 3");
    expect(msg).toContain('Command line: gen.sh "x"');
    expect(msg).toContain("stderr:\nerr1");
    expect(msg).toContain("stdout:\nout1");
  });

  it("reports a missing code and empty output", () => {
    const msg = programFailureMessage(null, "gen.sh", "", "  ");
    expect(msg).toContain("The program exited with code no code");
    expect(msg).toContain("Program output: (empty)");
  });
});

import js from "@eslint/js";
import tseslint from "typescript-eslint";

// 자식 프로세스의 'exit' 처리기에서 stdout/stderr 로 결과를 확정하지 않는다(AGENTS.md, M9 규칙화).
const exitBeforeOutput = {
  selector: "CallExpression[callee.property.name=/^(on|once)$/][arguments.0.value='exit'] Identifier[name=/^(stdout|stderr)$/]",
  message: "'exit' 는 마지막 출력보다 먼저 올 수 있습니다. stdout/stderr 를 쓰면 'close' 를 기다리세요.",
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/out/**", "**/node_modules/**", "release/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // 앱·패키지 코드: 표준 출력 용도의 console.log/debug 를 막는다. error/warn/info 는 로거가 생기기 전까지 허용.
    files: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    ignores: ["packages/cli/**", "**/*.test.ts"],
    rules: { "no-console": ["warn", { allow: ["error", "warn", "info"] }] },
  },
  {
    // 테스트: 고정 시간 sleep (`new Promise(r => setTimeout(r, n))`) 대신 조건 대기를 쓴다.
    files: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["warn", {
        selector: "NewExpression[callee.name='Promise'] > ArrowFunctionExpression > CallExpression[callee.name='setTimeout']",
        message: "고정 시간 sleep 대신 조건이 만족될 때까지 기다리세요 (vi.waitFor 등).",
      }, exitBeforeOutput],
    },
  },
  {
    // e2e 도우미(테스트 파일이 아닌 것)에도 'exit' 규칙만 적용한다.
    files: ["apps/desktop/e2e/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-syntax": ["warn", exitBeforeOutput] },
  },
);

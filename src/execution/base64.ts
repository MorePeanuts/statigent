/** 检查整帧产物的标准 Base64 字母表与尾部填充，不解码或复制大字符串。 */
export function validBase64(value: string): boolean {
  // 重复四字符分组的正则在大模型产物上会耗尽正则引擎的匹配预算。
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf("=");
  return (
    padding === -1 ||
    padding === value.length - 1 ||
    (padding === value.length - 2 && value.endsWith("=="))
  );
}

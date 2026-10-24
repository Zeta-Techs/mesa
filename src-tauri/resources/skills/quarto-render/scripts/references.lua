-- Mesa 参考文献过滤器：由 manuscript_font.py 拷进 manuscript/、写进源稿 YAML 的 filters。
-- 渲染时把引文库读一遍再交给 citeproc，引文库文件本身不改：
-- 1. 标题整体加一层花括号。Pandoc 读 BibTeX 时会把英文标题改成句首大写，元素符号跟着变小写
--    （Ru → ru、Ni-Mo-B → ni-mo-b，2026-10-23 HER 初稿参考文献表实证）。
-- 2. 去掉题名前人手加的编号（【74】、[12]、19~.），与同步到文献库的导出同一口径。
-- 3. 「待补」「待核」「无期号」是给人看的缺口标记，不进参考文献表（否则印出「p. 待补」）。
-- 4. 稿子里没有放参考文献的位置（#refs）时，在文末补一个不编号的 References 标题。

local PLACEHOLDERS = { ["待补"] = true, ["待核"] = true, ["无期号"] = true }

local function read_file(path)
  local f = io.open(path, "rb")
  if not f then return nil end
  local text = f:read("a")
  f:close()
  return text
end

local function locate(path)
  if read_file(path) then return path end
  local input = PANDOC_STATE and PANDOC_STATE.input_files and PANDOC_STATE.input_files[1]
  if input then
    local candidate = pandoc.path.join({ pandoc.path.directory(input), path })
    if read_file(candidate) then return candidate end
  end
  return nil
end

-- 从 open（左花括号的位置）找配对的右花括号
local function closing(text, open)
  local depth = 0
  for i = open, #text do
    local c = text:sub(i, i)
    if c == "{" then
      depth = depth + 1
    elseif c == "}" then
      depth = depth - 1
      if depth == 0 then return i end
    end
  end
  return nil
end

local function strip_prefix(title)
  local s = title:gsub("^%s+", "")
  for _, pat in ipairs({ "^【%s*%d+%s*】%s*", "^%[%s*%d+%s*%]%s*", "^%d+%s*~%s*%.?%s*" }) do
    local rest, n = s:gsub(pat, "", 1)
    if n > 0 and rest ~= "" then return rest end
  end
  return s
end

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

-- 逐个字段走一遍：name = {value}。标题加保护、去编号；缺口标记整条字段去掉
local function protect(text)
  local out, pos = {}, 1
  while true do
    local s, e, name = text:find("([%a][%w_%-]*)%s*=%s*{", pos)
    if not s then break end
    local close = closing(text, e)
    if not close then break end
    local value = text:sub(e + 1, close - 1)
    local lower = name:lower()
    if PLACEHOLDERS[trim(value)] then
      out[#out + 1] = text:sub(pos, s - 1)
      -- 连同后面的逗号一起去掉
      local after = text:sub(close + 1):match("^%s*,") or ""
      pos = close + 1 + #after
    elseif lower == "title" then
      local inner = value
      local bare = trim(inner)
      if bare:sub(1, 1) == "{" and closing(bare, 1) == #bare then
        inner = bare:sub(2, -2)
      end
      out[#out + 1] = text:sub(pos, s - 1) .. name .. " = {{" .. strip_prefix(inner) .. "}}"
      pos = close + 1
    else
      out[#out + 1] = text:sub(pos, close)
      pos = close + 1
    end
  end
  out[#out + 1] = text:sub(pos)
  return table.concat(out)
end

local function bib_paths(meta)
  local bib = meta.bibliography
  if not bib then return {} end
  local paths = {}
  if pandoc.utils.type(bib) == "List" then
    for _, item in ipairs(bib) do paths[#paths + 1] = pandoc.utils.stringify(item) end
  else
    paths[1] = pandoc.utils.stringify(bib)
  end
  return paths
end

local function has_refs(blocks)
  local found = false
  pandoc.walk_block(pandoc.Div(blocks), {
    Div = function(div)
      if div.identifier == "refs" then found = true end
    end,
  })
  return found
end

function Pandoc(doc)
  local refs = pandoc.List()
  if doc.meta.references then
    for _, r in ipairs(doc.meta.references) do refs:insert(r) end
  end
  local paths = bib_paths(doc.meta)
  for _, path in ipairs(paths) do
    local found = locate(path)
    -- 读不到或不是 .bib：不动，交回 citeproc 照常处理
    if not found or not found:lower():match("%.bib$") then return doc end
    local parsed = pandoc.read(protect(read_file(found)), "bibtex")
    for _, r in ipairs(parsed.meta.references or {}) do refs:insert(r) end
  end
  if #paths > 0 then
    doc.meta.references = refs
    doc.meta.bibliography = nil
  end
  if #refs > 0 and not has_refs(doc.blocks) then
    local level = 6
    for _, block in ipairs(doc.blocks) do
      if block.t == "Header" and block.level < level then level = block.level end
    end
    if level == 6 then level = 1 end
    local last = doc.blocks[#doc.blocks]
    local titled = last and last.t == "Header"
      and pandoc.utils.stringify(last):lower():match("^%s*references%s*$")
    if not titled then
      doc.blocks:insert(pandoc.Header(level, "References", pandoc.Attr("references", { "unnumbered" })))
    end
    doc.blocks:insert(pandoc.Div({}, pandoc.Attr("refs")))
  end
  return doc
end

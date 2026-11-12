-- Mesa 参考文献过滤器：由 manuscript_font.py 拷进 manuscript/、写进源稿 YAML 的 filters。
-- 渲染时把引文库读一遍再交给 citeproc，引文库文件本身不改：
-- 1. 标题整体加一层花括号。Pandoc 读 BibTeX 时会把英文标题改成句首大写，元素符号跟着变小写
--    （Ru → ru、Ni-Mo-B → ni-mo-b，2026-10-23 HER 初稿参考文献表实证）。
-- 2. 去掉题名前人手加的编号（【74】、[12]、19~.），与同步到文献库的导出同一口径。
-- 3. 「待补」「待核」「无期号」是给人看的缺口标记，不进参考文献表（否则印出「p. 待补」）。
-- 4. 稿子里没有放参考文献的位置（#refs）时，在文末补一个不编号的 References 标题。
-- 5. Unicode 上下标（H₂、cm⁻²、V₀.₃）换成真正的上下标排版：Times New Roman 等正文字体没有这些码位，
--    xelatex 印成空方块（2026-11-12 HER 初稿实证：全文 294 处）。正文与引文库题名都换，PDF / Word 同一口径。
-- 6. 只在 PDF：表格列宽按内容分（不再五列一样宽、长词压到隔壁列），单元格开头允许断词，表格用小一号字。

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


-- ---------- 上下标 ----------
local SUB = {
  ["₀"]="0",["₁"]="1",["₂"]="2",["₃"]="3",["₄"]="4",["₅"]="5",["₆"]="6",["₇"]="7",["₈"]="8",["₉"]="9",
  ["₊"]="+",["₋"]="−",["₌"]="=",["₍"]="(",["₎"]=")",
  ["ₐ"]="a",["ₑ"]="e",["ₒ"]="o",["ₓ"]="x",["ₔ"]="ə",["ₕ"]="h",["ₖ"]="k",["ₗ"]="l",["ₘ"]="m",["ₙ"]="n",["ₚ"]="p",["ₛ"]="s",["ₜ"]="t",
}
local SUP = {
  ["⁰"]="0",["¹"]="1",["²"]="2",["³"]="3",["⁴"]="4",["⁵"]="5",["⁶"]="6",["⁷"]="7",["⁸"]="8",["⁹"]="9",
  ["⁺"]="+",["⁻"]="−",["⁼"]="=",["⁽"]="(",["⁾"]=")",["ⁿ"]="n",["ⁱ"]="i",
}

-- 文本切成段：{kind = "text" | "sub" | "sup", text = ...}
local function script_runs(text)
  local runs = {}
  for _, cp in utf8.codes(text) do
    local ch = utf8.char(cp)
    local kind, out = "text", ch
    if SUB[ch] then kind, out = "sub", SUB[ch] elseif SUP[ch] then kind, out = "sup", SUP[ch] end
    local last = runs[#runs]
    if last and last.kind == kind then last.text = last.text .. out else runs[#runs + 1] = { kind = kind, text = out } end
  end
  -- 夹在两段下标（或上标）之间的小数点跟着走：V₀.₃ 排成 V 下标 0.3，不是小数点落在基线上
  local merged = {}
  for i, r in ipairs(runs) do
    local prev, nxt = merged[#merged], runs[i + 1]
    if r.kind == "text" and r.text == "." and prev and nxt and prev.kind ~= "text" and prev.kind == nxt.kind then
      prev.text = prev.text .. "."
      prev.join = true
    elseif prev and prev.join and prev.kind == r.kind then
      prev.text = prev.text .. r.text
      prev.join = nil
    else
      merged[#merged + 1] = r
    end
  end
  return merged
end

local function has_script(text)
  for _, cp in utf8.codes(text) do
    local ch = utf8.char(cp)
    if SUB[ch] or SUP[ch] then return true end
  end
  return false
end

function Str(el)
  if not has_script(el.text) then return nil end
  local out = pandoc.List()
  for _, r in ipairs(script_runs(el.text)) do
    if r.kind == "sub" then out:insert(pandoc.Subscript(pandoc.Str(r.text)))
    elseif r.kind == "sup" then out:insert(pandoc.Superscript(pandoc.Str(r.text)))
    else out:insert(pandoc.Str(r.text)) end
  end
  return out
end

-- 引文库原文里的上下标换成 LaTeX 命令，交给 bibtex 读成真正的上下标（题名「NbB₂」）
local function tex_scripts(text)
  if not has_script(text) then return text end
  local parts = {}
  for _, r in ipairs(script_runs(text)) do
    if r.kind == "sub" then parts[#parts + 1] = "\\textsubscript{" .. r.text .. "}"
    elseif r.kind == "sup" then parts[#parts + 1] = "\\textsuperscript{" .. r.text .. "}"
    else parts[#parts + 1] = r.text end
  end
  return table.concat(parts)
end

-- ---------- 表格（只在 PDF） ----------
local function cell_text(cell)
  return pandoc.utils.stringify(pandoc.Div(cell.contents))
end

local function longest_word(text)
  local n = 0
  for w in text:gmatch("%S+") do n = math.max(n, utf8.len(w) or #w) end
  return n
end

function Table(tbl)
  if not FORMAT:match("latex") then return nil end
  local cols = #tbl.colspecs
  if cols < 2 then return nil end
  local rows = pandoc.List()
  for _, r in ipairs(tbl.head.rows) do rows:insert(r) end
  for _, body in ipairs(tbl.bodies) do
    for _, r in ipairs(body.head) do rows:insert(r) end
    for _, r in ipairs(body.body) do rows:insert(r) end
  end
  local widest, total, word = {}, {}, {}
  local wide_row = 0
  for _, r in ipairs(rows) do
    local row_len = 0
    for j, cell in ipairs(r.cells) do
      local t = cell_text(cell)
      local n = utf8.len(t) or #t
      widest[j] = math.max(widest[j] or 0, n)
      total[j] = (total[j] or 0) + n
      word[j] = math.max(word[j] or 0, longest_word(t))
      row_len = row_len + n
      -- 单元格第一个词 LaTeX 不会断（段首词不参与断词），长词就压到隔壁列：开头垫一个零宽空白
      local first = cell.contents[1]
      if first and (first.t == "Plain" or first.t == "Para") then
        first.content:insert(1, pandoc.RawInline("latex", "\\hspace{0pt}"))
      end
    end
    wide_row = math.max(wide_row, row_len)
  end
  -- 窄表照 Pandoc 默认排（不换行、按内容宽）；只有一行放不下时才按内容分列宽
  -- 管道表一行超过 72 字时 Pandoc 按分隔行的短横线数给列宽：|---|---| 写法各列一样宽（HER 表 3 五列各 0.2），
  -- 等宽当没设、按内容重分；作者有意写了不同长度的短横线就照作者的
  local custom, first = false, nil
  for _, spec in ipairs(tbl.colspecs) do
    local w = spec[2]
    if w and w ~= 0 then
      first = first or w
      if math.abs(w - first) > 0.001 then custom = true end
    end
  end
  if not custom and wide_row > 70 then
    local weights, sum = {}, 0
    for j = 1, cols do
      local avg = (total[j] or 0) / math.max(#rows, 1)
      local w = math.max((word[j] or 1) * 1.1, math.min(widest[j] or 1, 60) * 0.35 + avg * 0.65, 6)
      weights[j] = w
      sum = sum + w
    end
    for j = 1, cols do
      tbl.colspecs[j] = { tbl.colspecs[j][1], 0.98 * weights[j] / sum }
    end
  end
  return {
    pandoc.RawBlock("latex", "\\begingroup\\small"),
    tbl,
    pandoc.RawBlock("latex", "\\endgroup"),
  }
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
    local parsed = pandoc.read(tex_scripts(protect(read_file(found))), "bibtex")
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

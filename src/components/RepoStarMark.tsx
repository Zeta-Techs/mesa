/** 设置 → 关于「项目主页」旁的星。
 *  进这一分区时沿轮廓描一笔，再填上当前主题的强调色，然后停住。
 *  分区切走会卸载，再进来会重播一次；不循环，避免在设置页里一直占注意力。
 *  pathLength=1，描边不用量真实周长。减少动态时直接是实心星（见 App.css）。 */
export function RepoStarMark() {
  return (
    <svg
      className="ccode-repo-star"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        pathLength={1}
        d="M8 1.55L9.56 5.91L14.18 6.04L10.52 8.87L11.82 13.31L8 10.7L4.18 13.31L5.48 8.87L1.82 6.04L6.44 5.91Z"
      />
    </svg>
  );
}

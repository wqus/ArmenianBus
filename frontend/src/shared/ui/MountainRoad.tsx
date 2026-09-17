export function MountainRoad() {
  return (
    <svg
      className="mountain-scene"
      viewBox="0 0 620 540"
      fill="none"
      role="img"
      aria-label="Дорога среди гор на фоне мягкого рассвета"
    >
      <defs>
        <linearGradient id="sky" x1="310" y1="0" x2="310" y2="540" gradientUnits="userSpaceOnUse">
          <stop stopColor="#e3e6fa" />
          <stop offset="1" stopColor="#f3e9ed" />
        </linearGradient>
        <linearGradient
          id="mountain"
          x1="266"
          y1="162"
          x2="440"
          y2="486"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#a5a6cd" />
          <stop offset="1" stopColor="#8c8eb8" />
        </linearGradient>
      </defs>
      <rect width="620" height="540" rx="32" fill="url(#sky)" />
      <circle cx="465" cy="136" r="55" fill="#fff4da" />
      <path
        d="M0 276 102 224 156 255 260 129 323 239 365 217 454 302 522 255 620 301V540H0Z"
        fill="#c0c2df"
      />
      <path d="m182 258 78-129 63 110-48-35-21 14-14-30-28 66Z" fill="#f5f4fa" />
      <path d="M0 396 148 218 260 363 384 155 568 393 620 360V540H0Z" fill="url(#mountain)" />
      <path d="m331 247 53-92 71 92-43-28-22 13-13-33-24 41Z" fill="#f5f4fa" />
      <path d="M0 414c147-32 198 56 326 5s173-49 294-7v128H0Z" fill="#737b9c" />
      <path d="M0 463c125-80 207 0 315 3s201-73 305-23v97H0Z" fill="#5c6c82" />
      <path
        d="M290 540c86-38 174-54 167-78-6-19-143-25-139-47 4-18 72-24 61-40"
        stroke="#eae7e8"
        strokeWidth="54"
      />
      <path
        d="M290 540c86-38 174-54 167-78-6-19-143-25-139-47 4-18 72-24 61-40"
        stroke="#b4b1c3"
        strokeWidth="2"
        strokeDasharray="10 12"
      />
      <path
        d="M79 360v37m-10-12 10-25 11 25H69ZM539 390v26m-8-9 8-20 8 20h-16Z"
        fill="#536478"
        stroke="#536478"
        strokeWidth="2"
      />
      <g opacity=".65" stroke="white" strokeWidth="1">
        <path d="M35 38h26M35 38v26M585 38h-26M585 38v26M35 502h26M35 502v-26M585 502h-26M585 502v-26" />
      </g>
    </svg>
  )
}

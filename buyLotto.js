import puppeteer from "puppeteer";
import axios from "axios";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const USER_ID = process.argv[2];
const USER_PW = process.argv[3];
const SLACK_API_URL = "https://slack.com/api/chat.postMessage";
const SLACK_BOT_TOKEN = process.argv[4];
const SLACK_CHANNEL = process.argv[5];
const COUNT = process.argv[6];

class BalanceError extends Error {
  constructor(message = "An error occurred", code = null) {
    super(message);
    this.code = code;
  }

  toString() {
    return this.code ? `${this.message} - Code: ${this.code}` : this.message;
  }
}

function getNow() {
  return dayjs().tz("Asia/Seoul").format("YYYY-MM-DD HH:mm:ss");
}

async function hookSlack(message) {
  const koreaTimeStr = getNow();
  const payload = {
    text: `> ${koreaTimeStr} *로또 자동 구매 봇 알림* \n${message}`,
    channel: SLACK_CHANNEL,
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
  };
  return axios.post(SLACK_API_URL, payload, { headers });
}

async function hookSlackBtn() {
  const koreaTimeStr = getNow();
  const payload = {
    channel: SLACK_CHANNEL,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `> ${koreaTimeStr} *로또 자동 구매 봇 알림* \n예치금이 부족합니다! 충전을 해주세요!`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "충전하러 가기",
              emoji: true,
            },
            url: "https://dhlottery.co.kr/payment.do?method=payment",
            action_id: "button_action",
          },
        ],
      },
    ],
  };
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
  };
  return axios.post(SLACK_API_URL, payload, { headers });
}

(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  try {
    // 초기 세팅 및 로그인
    await page.goto("https://dhlottery.co.kr/user.do?method=login");
    await page.type('[placeholder="아이디"]', USER_ID);
    await page.type('[placeholder="비밀번호"]', USER_PW);
    await Promise.all([page.waitForNavigation(), page.click('form[name="jform"] >> text=로그인')]);
    await page.waitForTimeout(4000);

    // 로그인 이후 기본 정보 체크 & 예치금 알림
    await page.goto("https://dhlottery.co.kr/common.do?method=main");
    const moneyInfo = await page.$eval("ul.information", (el) => el.innerText.split("\n"));
    const userName = moneyInfo[0];
    const moneyAmount = parseInt(moneyInfo[2].replace(/,/g, "").replace("원", ""));
    await hookSlack(`로그인 사용자: ${userName}, 예치금: ${moneyAmount}`);

    if (1000 * parseInt(COUNT) > moneyAmount) {
      throw new BalanceError();
    }

    // 구매하기
    await page.goto("https://ol.dhlottery.co.kr/olotto/game/game645.do");
    await page.click("#popupLayerAlert button[name='확인']");
    await page.click("text=자동번호발급");
    await page.select("select", COUNT);
    await page.click("text=확인");
    await page.click('input:has-text("구매하기")');
    await page.waitForTimeout(2000);
    await page.click('text=확인 취소 >> input[type="button"]');
    await page.click('input[name="closeLayer"]');

    await hookSlack(
      `${COUNT}개 복권 구매 성공! \n자세하게 확인하기: https://dhlottery.co.kr/myPage.do?method=notScratchListView`
    );

    // 오늘 구매한 복권 번호 확인하기
    const cookies = await page.cookies();
    const session = axios.create();
    cookies.forEach((cookie) => {
      session.defaults.headers.Cookie = `${cookie.name}=${cookie.value}`;
    });

    const nowDate = dayjs().tz("Asia/Seoul").format("YYYYMMDD");
    const payload = `searchStartDate=${nowDate}&searchEndDate=${nowDate}&winGrade=2`;
    const headers = {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };
    const res = await session.post("https://dhlottery.co.kr/myPage.do?method=lottoBuyList", payload, { headers });
    const html = new DOMParser().parseFromString(res.data, "text/html");
    const aTagHref = html.querySelector("tbody > tr:nth-child(1) > td:nth-child(4) > a").getAttribute("href");
    const detailInfo = aTagHref.match(/\d+/g);
    await page.goto(
      `https://dhlottery.co.kr/myPage.do?method=lotto645Detail&orderNo=${detailInfo[0]}&barcode=${detailInfo[1]}&issueNo=${detailInfo[2]}`
    );

    let resultMsg = "";
    const results = await page.$$eval("div.selected li", (elements) =>
      elements.map((el) => el.innerText.split("\n").join(", "))
    );
    resultMsg = results.join("\n");
    await hookSlack(`이번주 나의 행운의 번호는?!\n${resultMsg}`);
  } catch (error) {
    console.log(`error: ${JSON.stringify(error)}`);

    if (error instanceof BalanceError) {
      await hookSlackBtn();
    } else {
      await hookSlack(error.toString());
    }
  } finally {
    await browser.close();
  }
})();

'use client';

import { useI18n } from '@/lib/i18n';
import { Card, CardContent } from '@/components/ui/card';

export default function AgreementPage() {
  const { locale } = useI18n();

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="text-3xl font-bold">
        {locale === 'zh' ? '用户服务协议' : 'Terms of Service'}
      </h1>
      <Card className="mt-8 border-border/60">
        <CardContent className="prose prose-sm max-w-none space-y-6 p-8">
          {locale === 'zh' ? (
            <>
              <section>
                <h2 className="text-xl font-semibold">一、协议说明</h2>
                <p className="text-muted-foreground">
                  欢迎使用 NodeShop 网络服务。在使用本服务前，请您仔细阅读并理解本协议的全部内容。您点击"注册"即表示您已阅读、理解并同意接受本协议的约束。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">二、服务内容</h2>
                <p className="text-muted-foreground">
                  本平台为用户提供网络代理节点服务，包括但不限于节点订阅、SOCKS5中转等服务。用户购买套餐后，系统将自动为指定节点开通服务。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">三、账号管理</h2>
                <p className="text-muted-foreground">
                  用户应妥善保管自己的账号密码。因用户保管不善导致的账号被盗、数据丢失等损失，由用户自行承担。用户不得将账号转让、出借或用于其他违规用途。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">四、使用规范</h2>
                <p className="text-muted-foreground">
                  用户承诺不利用本服务从事任何违反法律法规的活动，包括但不限于：危害国家安全、暴力恐怖、赌博、传播违法信息等。平台有权对违规账号采取暂停或永久封禁处理，且不退还相应费用。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">五、费用与退款</h2>
                <p className="text-muted-foreground">
                  用户购买的服务费用一经支付，除因平台自身原因导致服务完全不可用的情形外，一般不予退款。卡密兑换的余额仅可用于本平台消费，不可提现。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">六、服务变更与终止</h2>
                <p className="text-muted-foreground">
                  平台有权根据运营情况调整、变更或终止各项服务。服务到期后未续费，对应节点将自动停止。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">七、隐私保护</h2>
                <p className="text-muted-foreground">
                  平台将严格保护用户隐私，仅在提供服务所必需的范围内收集和使用用户信息，不会向第三方出售或泄露用户个人信息。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">八、免责声明</h2>
                <p className="text-muted-foreground">
                  由于网络环境、运营商政策等不可控因素，平台不保证服务的绝对稳定性和可用性。因上述原因导致的服务中断，平台将尽力协调解决，但不承担相应赔偿责任。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">九、协议修订</h2>
                <p className="text-muted-foreground">
                  平台有权对本协议进行修订，修订后的协议将在平台公示。用户继续使用服务即视为接受修订后的协议。
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">十、联系我们</h2>
                <p className="text-muted-foreground">
                  如对本协议有任何疑问，请通过工单系统或邮件联系我们。
                </p>
              </section>
            </>
          ) : (
            <>
              <section>
                <h2 className="text-xl font-semibold">1. General</h2>
                <p className="text-muted-foreground">
                  Welcome to NodeShop. By registering an account, you agree to these Terms of Service. Please read them carefully before using our services.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">2. Services</h2>
                <p className="text-muted-foreground">
                  We provide network proxy node services including subscription nodes and SOCKS5 relay. Nodes are automatically activated after purchase.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">3. Account</h2>
                <p className="text-muted-foreground">
                  You are responsible for maintaining the confidentiality of your account credentials. You may not transfer or lend your account to others.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">4. Acceptable Use</h2>
                <p className="text-muted-foreground">
                  You agree not to use our services for any unlawful activities. We reserve the right to suspend or terminate accounts that violate these terms without refund.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">5. Payments & Refunds</h2>
                <p className="text-muted-foreground">
                  Payments are generally non-refundable except where our service is completely unavailable due to our own fault. Card-redeemed balances are for platform use only and non-withdrawable.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">6. Service Changes</h2>
                <p className="text-muted-foreground">
                  We may adjust, change, or terminate services based on operational needs. Services stop automatically upon expiry without renewal.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">7. Privacy</h2>
                <p className="text-muted-foreground">
                  We protect your privacy and only collect information necessary to provide services. We do not sell or disclose your personal information to third parties.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">8. Disclaimer</h2>
                <p className="text-muted-foreground">
                  Due to uncontrollable network factors, we do not guarantee absolute stability or availability. While we will make best efforts to resolve interruptions, we are not liable for consequent damages.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">9. Amendments</h2>
                <p className="text-muted-foreground">
                  We may amend these terms. Amended terms will be posted on the platform. Continued use constitutes acceptance.
                </p>
              </section>

              <section>
                <h2 className="text-xl font-semibold">10. Contact</h2>
                <p className="text-muted-foreground">
                  For any questions, please contact us via our support ticket system.
                </p>
              </section>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
